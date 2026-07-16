package notification

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type fakeStore struct {
	rows        []domain.NotificationRecord
	recentRows  []domain.NotificationRecord
	markRow     domain.NotificationRecord
	markOK      bool
	markAllRows []domain.NotificationRecord
	err         error
}

func (f *fakeStore) CreateNotification(context.Context, domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	return domain.NotificationRecord{}, false, nil
}

func (f *fakeStore) ListUnreadNotifications(_ context.Context, _ int) ([]domain.NotificationRecord, error) {
	return f.rows, f.err
}

func (f *fakeStore) ListRecentNotifications(_ context.Context, _ int) ([]domain.NotificationRecord, error) {
	return f.recentRows, f.err
}

func (f *fakeStore) MarkNotificationRead(_ context.Context, _ string) (domain.NotificationRecord, bool, error) {
	return f.markRow, f.markOK, f.err
}

func (f *fakeStore) MarkAllNotificationsRead(context.Context) ([]domain.NotificationRecord, error) {
	return f.markAllRows, f.err
}

func TestListUnreadAddsTargets(t *testing.T) {
	st := &fakeStore{rows: []domain.NotificationRecord{
		{ID: "n1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs", Status: domain.NotificationUnread, CreatedAt: time.Now()},
		{ID: "n2", SessionID: "mer-1", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "ready", Status: domain.NotificationUnread, CreatedAt: time.Now()},
	}}
	mgr := New(Deps{Store: st})
	got, err := mgr.List(context.Background(), ListFilter{Status: ListStatusUnread, Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got[0].Target.Kind != TargetSession || got[1].Target.Kind != TargetPR || got[1].Target.PRURL == "" {
		t.Fatalf("targets = %+v", got)
	}
}

func TestListAllAddsTargets(t *testing.T) {
	st := &fakeStore{recentRows: []domain.NotificationRecord{
		{ID: "n1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs", Status: domain.NotificationRead, CreatedAt: time.Now()},
		{ID: "n2", SessionID: "mer-1", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "ready", Status: domain.NotificationUnread, CreatedAt: time.Now()},
	}}
	mgr := New(Deps{Store: st})
	got, err := mgr.List(context.Background(), ListFilter{Status: ListStatusAll, Limit: 10})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got[0].Status != domain.NotificationRead || got[0].Target.Kind != TargetSession || got[1].Target.Kind != TargetPR {
		t.Fatalf("notifications = %+v", got)
	}
}

func TestMarkReadAddsTarget(t *testing.T) {
	st := &fakeStore{
		markRow: domain.NotificationRecord{
			ID: "n2", SessionID: "mer-1", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/1",
			Type: domain.NotificationReadyToMerge, Title: "ready", Status: domain.NotificationRead, CreatedAt: time.Now(),
		},
		markOK: true,
	}
	mgr := New(Deps{Store: st})
	got, ok, err := mgr.MarkRead(context.Background(), "n2")
	if err != nil || !ok {
		t.Fatalf("MarkRead ok=%v err=%v", ok, err)
	}
	if got.Status != domain.NotificationRead || got.Target.Kind != TargetPR || got.Target.PRURL == "" {
		t.Fatalf("notification = %+v", got)
	}
}

func TestMarkReadMissingReturnsNotFound(t *testing.T) {
	mgr := New(Deps{Store: &fakeStore{}})
	_, _, err := mgr.MarkRead(context.Background(), "missing")
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Kind != apierr.KindNotFound || apiErr.Code != "NOTIFICATION_NOT_FOUND" {
		t.Fatalf("err = %v, want notification not found", err)
	}
}

func TestMarkAllReadAddsTargets(t *testing.T) {
	st := &fakeStore{markAllRows: []domain.NotificationRecord{{
		ID: "n1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs", Status: domain.NotificationRead, CreatedAt: time.Now(),
	}}}
	mgr := New(Deps{Store: st})
	got, err := mgr.MarkAllRead(context.Background())
	if err != nil {
		t.Fatalf("MarkAllRead: %v", err)
	}
	if len(got) != 1 || got[0].Target.Kind != TargetSession || got[0].Status != domain.NotificationRead {
		t.Fatalf("notifications = %+v", got)
	}
}

func TestListRequiresStore(t *testing.T) {
	_, err := New(Deps{}).List(context.Background(), ListFilter{})
	if err == nil {
		t.Fatal("want missing store error")
	}
}
