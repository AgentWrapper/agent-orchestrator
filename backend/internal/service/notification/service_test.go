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
	rows         []domain.NotificationRecord
	listStatus   ListStatus
	listBeforeAt time.Time
	listBeforeID string
	listLimit    int
	unreadCount  int64
	markRow      domain.NotificationRecord
	markOK       bool
	markAllCount int64
	err          error
}

func (f *fakeStore) CreateNotification(context.Context, domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	return domain.NotificationRecord{}, false, nil
}

func (f *fakeStore) ListNotifications(
	_ context.Context,
	status ListStatus,
	beforeCreatedAt time.Time,
	beforeID string,
	limit int,
) ([]domain.NotificationRecord, error) {
	f.listStatus = status
	f.listBeforeAt = beforeCreatedAt
	f.listBeforeID = beforeID
	f.listLimit = limit
	return f.rows, f.err
}

func (f *fakeStore) CountUnreadNotifications(context.Context) (int64, error) {
	return f.unreadCount, f.err
}

func (f *fakeStore) MarkNotificationRead(_ context.Context, _ string) (domain.NotificationRecord, bool, error) {
	return f.markRow, f.markOK, f.err
}

func (f *fakeStore) MarkAllNotificationsRead(context.Context) (int64, error) {
	return f.markAllCount, f.err
}

func TestListAddsTargetsAndReturnsNextCursor(t *testing.T) {
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	st := &fakeStore{rows: []domain.NotificationRecord{
		{ID: "n3", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs", Status: domain.NotificationUnread, CreatedAt: now},
		{ID: "n2", SessionID: "mer-1", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "ready", Status: domain.NotificationUnread, CreatedAt: now.Add(-time.Minute)},
		{ID: "n1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "older", Status: domain.NotificationRead, CreatedAt: now.Add(-2 * time.Minute)},
	}, unreadCount: 2}
	mgr := New(Deps{Store: st})
	got, err := mgr.List(context.Background(), ListFilter{Status: ListAll, Limit: 2})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got.Notifications) != 2 || got.Notifications[0].Target.Kind != TargetSession ||
		got.Notifications[1].Target.Kind != TargetPR || got.Notifications[1].Target.PRURL == "" {
		t.Fatalf("targets = %+v", got)
	}
	if got.UnreadCount != 2 || got.NextCursor == "" {
		t.Fatalf("page = %+v", got)
	}
	cursorAt, cursorID, err := decodeCursor(got.NextCursor)
	if err != nil || !cursorAt.Equal(now.Add(-time.Minute)) || cursorID != "n2" {
		t.Fatalf("cursor at=%s id=%q err=%v", cursorAt, cursorID, err)
	}
	if st.listStatus != ListAll || st.listLimit != 3 || !st.listBeforeAt.IsZero() || st.listBeforeID != "" {
		t.Fatalf("list filter status=%q before=%s/%q limit=%d", st.listStatus, st.listBeforeAt, st.listBeforeID, st.listLimit)
	}
}

func TestListDefaultsToUnreadAndOneHundred(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st})
	if _, err := mgr.List(context.Background(), ListFilter{}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if st.listStatus != ListUnread || st.listLimit != DefaultListLimit+1 {
		t.Fatalf("list status=%q limit=%d", st.listStatus, st.listLimit)
	}
}

func TestListRejectsInvalidCursor(t *testing.T) {
	_, err := New(Deps{Store: &fakeStore{}}).List(context.Background(), ListFilter{Cursor: "not-a-cursor"})
	var apiErr *apierr.Error
	if !errors.As(err, &apiErr) || apiErr.Code != "INVALID_NOTIFICATION_CURSOR" {
		t.Fatalf("err = %v, want invalid cursor", err)
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

func TestMarkAllReadReturnsUpdatedCount(t *testing.T) {
	st := &fakeStore{markAllCount: 42}
	mgr := New(Deps{Store: st})
	got, err := mgr.MarkAllRead(context.Background())
	if err != nil {
		t.Fatalf("MarkAllRead: %v", err)
	}
	if got != 42 {
		t.Fatalf("updated count = %d, want 42", got)
	}
}

func TestListUnreadRequiresStore(t *testing.T) {
	_, err := New(Deps{}).List(context.Background(), ListFilter{})
	if err == nil {
		t.Fatal("want missing store error")
	}
}
