package notify

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	rows      []domain.NotificationRecord
	duplicate bool
	err       error
}

func (f *fakeStore) CreateNotification(_ context.Context, rec domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	if f.err != nil {
		return domain.NotificationRecord{}, false, f.err
	}
	if f.duplicate {
		return domain.NotificationRecord{}, false, nil
	}
	f.rows = append(f.rows, rec)
	return rec, true, nil
}

func TestManagerNotifyPersistsThenPublishes(t *testing.T) {
	st := &fakeStore{}
	hub := NewHub()
	ch, unsub := hub.Subscribe("")
	defer unsub()
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Publisher: hub, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	if err := mgr.Notify(context.Background(), Intent{Type: domain.NotificationNeedsInput, SessionID: "mer-1", ProjectID: "mer", SessionDisplayName: "checkout-flow"}); err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if len(st.rows) != 1 {
		t.Fatalf("stored rows = %d, want 1", len(st.rows))
	}
	if got := st.rows[0]; got.ID != "ntf_1" || got.CreatedAt != now || got.Status != domain.NotificationUnread || got.Title != "checkout-flow needs input" {
		t.Fatalf("stored notification = %+v", got)
	}
	select {
	case got := <-ch:
		if got.ID != "ntf_1" {
			t.Fatalf("published = %+v", got)
		}
	default:
		t.Fatal("expected published notification")
	}
}

func TestManagerNotifyCarriesSensitivePRMetadata(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:         domain.NotificationReadyToMerge,
		SessionID:    "mer-1",
		ProjectID:    "mer",
		PRURL:        "https://github.com/o/r/pull/1",
		Sensitive:    true,
		ChangedPaths: []string{"backend/internal/lifecycle/reactions.go"},
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := st.rows[0]; !got.Sensitive || !reflect.DeepEqual(got.ChangedPaths, []string{"backend/internal/lifecycle/reactions.go"}) {
		t.Fatalf("stored notification metadata = sensitive:%v paths:%#v", got.Sensitive, got.ChangedPaths)
	}
}

func TestManagerNotifyAcceptsOrchestratorReplacementWithoutPR(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationOrchestratorReplaced,
		SessionID:          "mer-orch-2",
		ProjectID:          "mer",
		SessionDisplayName: "mer orchestrator",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := st.rows[0]; got.PRURL != "" || got.Title != "mer orchestrator was replaced" || got.Body == "" {
		t.Fatalf("stored notification = %+v, want session-targeted replacement without PR URL", got)
	}
}

func TestManagerNotifyPrimeReplacementUsesPrimeBody(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationOrchestratorReplaced,
		SessionID:          "ao-prime",
		ProjectID:          "ao",
		SessionKind:        domain.KindPrime,
		SessionDisplayName: "ao Prime",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := st.rows[0]; got.Body != "AO replaced an unresponsive prime orchestrator." {
		t.Fatalf("body = %q, want prime replacement copy", got.Body)
	}
}

func TestManagerNotifyPrimeReplacementCappedUsesPrimeBody(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationOrchestratorReplacementCapped,
		SessionID:          "ao-prime",
		ProjectID:          "ao",
		SessionKind:        domain.KindPrime,
		SessionDisplayName: "ao Prime",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if got := st.rows[0]; got.Body != "AO stopped replacing the prime orchestrator after repeated failures. Inspect the harness, auth, and hook pipeline." {
		t.Fatalf("body = %q, want prime replacement cap copy", got.Body)
	}
}

func TestManagerNotifyWorkerDiedUnfinished(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationWorkerDiedUnfinished,
		SessionID:          "demo-1",
		ProjectID:          "demo",
		SessionDisplayName: "demo #12 fix-login",
		IssueID:            "github:acme/demo#12",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Title != "worker died with unfinished work: issue #12" {
		t.Fatalf("title = %q", got.Title)
	}
	if got.Body != "demo #12 fix-login terminated before issue #12 landed; ao will dispatch a clean replacement if retry capacity remains." {
		t.Fatalf("body = %q", got.Body)
	}
}

func TestManagerNotifyWorkerDiedUnfinishedAdoptsOpenPR(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC) }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationWorkerDiedUnfinished,
		SessionID:          "demo-1",
		ProjectID:          "demo",
		SessionDisplayName: "demo #12 fix-login",
		IssueID:            "github:acme/demo#12",
		PRURL:              "https://github.com/acme/demo/pull/99",
		AdoptsOpenPR:       true,
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Body != "demo #12 fix-login terminated before issue #12 landed with an open PR; ao is dispatching a replacement to adopt https://github.com/acme/demo/pull/99." {
		t.Fatalf("body = %q", got.Body)
	}
}

func TestManagerNotifyWorkerRetryExhausted(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC) }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationWorkerRetryExhausted,
		SessionID:          "demo-3",
		ProjectID:          "demo",
		SessionDisplayName: "demo #12 fix-login",
		IssueID:            "github:acme/demo#12",
		RetryCount:         3,
		RetryLimit:         2,
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Title != "worker retry cap exhausted: issue #12" {
		t.Fatalf("title = %q", got.Title)
	}
	if got.Body != "demo #12 fix-login terminated after 3 attempts for issue #12; retry cap is 2, so ao is leaving it for a human." {
		t.Fatalf("body = %q", got.Body)
	}
}

func TestManagerNotifyWorkerRetryExhaustedIncludesFailurePoint(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC) }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:                  domain.NotificationWorkerRetryExhausted,
		SessionID:             "demo-3",
		ProjectID:             "demo",
		SessionDisplayName:    "demo #12 fix-login",
		IssueID:               "github:acme/demo#12",
		RetryCount:            3,
		RetryLimit:            2,
		TerminalFailureReason: "CI / backend test",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Body != "demo #12 fix-login terminated after 3 attempts for issue #12; retry cap is 2, so ao is leaving it for a human. Latest failure point: CI / backend test." {
		t.Fatalf("body = %q", got.Body)
	}
}

func TestManagerNotifyMainCIRed(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 11, 10, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_main_red" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:         domain.NotificationMainCIRed,
		SessionID:    "main",
		ProjectID:    "ao",
		Repo:         "polymath-ventures/agent-orchestrator",
		HeadSHA:      "fee462ed3aabb",
		ChangedPaths: []string{"go", "cli-e2e"},
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Title != "main is red at fee462ed: go, cli-e2e" {
		t.Fatalf("title = %q", got.Title)
	}
	if got.Body != "Main-branch CI failed for polymath-ventures/agent-orchestrator at fee462ed. Merge is frozen until main is green; only fix PRs should merge." {
		t.Fatalf("body = %q", got.Body)
	}
	if got.Type != domain.NotificationMainCIRed || got.HeadSHA != "fee462ed3aabb" {
		t.Fatalf("record = %+v", got)
	}
}

func TestManagerNotifyWorkerRetryExhaustedNamesOrphanedPR(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC) }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationWorkerRetryExhausted,
		SessionID:          "demo-3",
		ProjectID:          "demo",
		SessionDisplayName: "demo #12 fix-login",
		IssueID:            "github:acme/demo#12",
		PRURL:              "https://github.com/acme/demo/pull/99",
		RetryCount:         3,
		RetryLimit:         2,
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Body != "demo #12 fix-login terminated after 3 attempts for issue #12; retry cap is 2, so ao is suspending respawns and leaving the orphaned PR https://github.com/acme/demo/pull/99 for a human." {
		t.Fatalf("body = %q", got.Body)
	}
}

func TestManagerNotifyWorkerRetryBlockedNamesReason(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC) }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:               domain.NotificationWorkerRetryExhausted,
		SessionID:          "demo-3",
		ProjectID:          "demo",
		SessionDisplayName: "demo #12 fix-login",
		IssueID:            "github:acme/demo#12",
		PRURL:              "https://github.com/acme/demo/pull/99",
		Reason:             "the orphaned PR has no recorded source branch to adopt",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	got := st.rows[0]
	if got.Title != "worker respawn blocked: issue #12" {
		t.Fatalf("title = %q", got.Title)
	}
	want := "demo #12 fix-login terminated before issue #12 landed with an orphaned PR https://github.com/acme/demo/pull/99; ao is suspending respawns because the orphaned PR has no recorded source branch to adopt."
	if got.Body != want {
		t.Fatalf("body = %q, want %q", got.Body, want)
	}
}

func TestManagerNotifyDuplicateDoesNotPublish(t *testing.T) {
	st := &fakeStore{duplicate: true}
	hub := NewHub()
	ch, unsub := hub.Subscribe("")
	defer unsub()
	mgr := New(Deps{Store: st, Publisher: hub, Clock: func() time.Time { return time.Now() }, NewID: func() string { return "ntf_1" }})

	if err := mgr.Notify(context.Background(), Intent{Type: domain.NotificationNeedsInput, SessionID: "mer-1", ProjectID: "mer", CreatedAt: time.Now()}); err != nil {
		t.Fatalf("Notify duplicate: %v", err)
	}
	select {
	case got := <-ch:
		t.Fatalf("duplicate published %+v", got)
	default:
	}
}

func TestManagerNotifyRejectsUnknownType(t *testing.T) {
	mgr := New(Deps{Store: &fakeStore{}, Clock: func() time.Time { return time.Now() }})
	err := mgr.Notify(context.Background(), Intent{Type: "surprise", SessionID: "mer-1", ProjectID: "mer"})
	if !errors.Is(err, domain.ErrInvalidNotificationType) {
		t.Fatalf("err = %v, want invalid type", err)
	}
}

// A duplicate_pr intent is enriched with a title/body that names the existing PR
// and the shared issue (issue #181).
func TestManagerNotifyDuplicatePREnrichment(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 10, 10, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_dup" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:             domain.NotificationDuplicatePR,
		SessionID:        "ao-94b",
		ProjectID:        "ao",
		PRURL:            "https://github.com/acme/demo/pull/180",
		PRNumber:         180,
		IssueRef:         "acme/demo#169",
		DuplicateOfPRURL: "https://github.com/acme/demo/pull/172",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if len(st.rows) != 1 {
		t.Fatalf("stored rows = %d, want 1", len(st.rows))
	}
	got := st.rows[0]
	if got.Type != domain.NotificationDuplicatePR {
		t.Fatalf("type = %q, want duplicate_pr", got.Type)
	}
	if !strings.Contains(got.Title, "180") {
		t.Fatalf("title should name the duplicate PR number; got %q", got.Title)
	}
	if !strings.Contains(got.Body, "https://github.com/acme/demo/pull/172") || !strings.Contains(got.Body, "acme/demo#169") {
		t.Fatalf("body should name the existing PR and issue; got %q", got.Body)
	}
}

// duplicate_pr is a PR-scoped alert: the whole point is naming the offending PR,
// so a duplicate_pr intent with no PRURL is invalid and must be rejected rather
// than stored with an empty pr_url (which would also collide in the unread
// dedupe index). This pins the requiresPR contract for the type (issue #181).
func TestManagerNotifyRejectsDuplicatePRWithoutPRURL(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st, Clock: func() time.Time { return time.Now() }, NewID: func() string { return "ntf_1" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:             domain.NotificationDuplicatePR,
		SessionID:        "ao-94b",
		ProjectID:        "ao",
		IssueRef:         "acme/demo#169",
		DuplicateOfPRURL: "https://github.com/acme/demo/pull/172",
	})
	if !errors.Is(err, domain.ErrInvalidNotificationRecord) {
		t.Fatalf("err = %v, want invalid record for duplicate_pr without a PR URL", err)
	}
	if len(st.rows) != 0 {
		t.Fatalf("stored rows = %d, want 0 (invalid intent must not persist)", len(st.rows))
	}
}

func TestManagerNotifyModelUnreachable(t *testing.T) {
	st := &fakeStore{}
	now := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC)
	mgr := New(Deps{Store: st, Clock: func() time.Time { return now }, NewID: func() string { return "ntf_model" }})

	err := mgr.Notify(context.Background(), Intent{
		Type:         domain.NotificationModelUnreachable,
		SessionID:    "ao-model-codex-gpt-5-5-codex",
		ProjectID:    "ao",
		ModelHarness: domain.HarnessCodex,
		Model:        "gpt-5.5-codex",
		ModelScope:   "workerMix[0].model",
		Reason:       "400 model not available",
	})
	if err != nil {
		t.Fatalf("Notify: %v", err)
	}
	if len(st.rows) != 1 {
		t.Fatalf("stored rows = %d, want 1", len(st.rows))
	}
	got := st.rows[0]
	if got.Type != domain.NotificationModelUnreachable || got.PRURL != "" || got.Title != "gpt-5.5-codex model unreachable" {
		t.Fatalf("stored notification = %+v", got)
	}
	if !strings.Contains(got.Body, "400 model not available") {
		t.Fatalf("body = %q, want reason", got.Body)
	}
}

func TestHubProjectFilter(t *testing.T) {
	hub := NewHub()
	ch, unsub := hub.Subscribe("mer")
	defer unsub()
	_ = hub.Publish(context.Background(), domain.NotificationRecord{ID: "skip", ProjectID: "ao"})
	_ = hub.Publish(context.Background(), domain.NotificationRecord{ID: "keep", ProjectID: "mer"})
	select {
	case got := <-ch:
		if got.ID != "keep" {
			t.Fatalf("published = %+v", got)
		}
	default:
		t.Fatal("expected filtered notification")
	}
}
