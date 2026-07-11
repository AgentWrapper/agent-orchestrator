package notify

import (
	"context"
	"errors"
	"reflect"
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
