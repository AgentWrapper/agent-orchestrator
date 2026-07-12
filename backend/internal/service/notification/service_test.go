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
	listFilter   ListFilter
	markRow      domain.NotificationRecord
	markOK       bool
	markAllRows  []domain.NotificationRecord
	excludeTypes []domain.NotificationType
	err          error
}

func (f *fakeStore) CreateNotification(context.Context, domain.NotificationRecord) (domain.NotificationRecord, bool, error) {
	return domain.NotificationRecord{}, false, nil
}

func (f *fakeStore) ListUnreadNotifications(_ context.Context, filter ListFilter) ([]domain.NotificationRecord, error) {
	f.listFilter = filter
	return f.rows, f.err
}

func (f *fakeStore) MarkNotificationRead(_ context.Context, _ string) (domain.NotificationRecord, bool, error) {
	return f.markRow, f.markOK, f.err
}

func (f *fakeStore) MarkAllNotificationsRead(_ context.Context, excludeTypes []domain.NotificationType) ([]domain.NotificationRecord, error) {
	f.excludeTypes = excludeTypes
	return f.markAllRows, f.err
}

func TestListUnreadAddsTargets(t *testing.T) {
	st := &fakeStore{rows: []domain.NotificationRecord{
		{ID: "n1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs", Status: domain.NotificationUnread, CreatedAt: time.Now()},
		{ID: "n2", SessionID: "mer-1", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/1", Type: domain.NotificationReadyToMerge, Title: "ready", Status: domain.NotificationUnread, CreatedAt: time.Now()},
		{ID: "n3", SessionID: "model-1", ProjectID: "mer", Type: domain.NotificationModelUnreachable, Title: "model unreachable", Status: domain.NotificationUnread, CreatedAt: time.Now()},
		{ID: "n4", SessionID: "mer-2", ProjectID: "mer", PRURL: "https://github.com/o/r/pull/2", Type: domain.NotificationWorkerRetryExhausted, Title: "worker retry exhausted", Status: domain.NotificationUnread, CreatedAt: time.Now()},
	}}
	mgr := New(Deps{Store: st})
	got, err := mgr.ListUnread(context.Background(), ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListUnread: %v", err)
	}
	if got[0].Target.Kind != TargetSession || got[1].Target.Kind != TargetPR || got[1].Target.PRURL == "" || got[2].Target.Kind != TargetNone || got[2].Target.SessionID != "" || got[3].Target.Kind != TargetPR || got[3].Target.PRURL == "" {
		t.Fatalf("targets = %+v", got)
	}
	if got[0].Subject.Kind != domain.NotificationSubjectSession || got[0].Subject.ID != "mer-1" {
		t.Fatalf("session subject = %+v", got[0].Subject)
	}
	if got[1].Subject.Kind != domain.NotificationSubjectPR || got[1].Subject.ID != "https://github.com/o/r/pull/1" {
		t.Fatalf("pr subject = %+v", got[1].Subject)
	}
	if got[2].Subject.Kind != domain.NotificationSubjectModel || got[2].Subject.ID != "model-1" {
		t.Fatalf("model subject = %+v", got[2].Subject)
	}
	if got[3].Subject.Kind != domain.NotificationSubjectSession || got[3].Subject.ID != "mer-2" {
		t.Fatalf("worker subject = %+v", got[3].Subject)
	}
}

func TestListUnreadPassesTypeFilterAndNormalizesLimit(t *testing.T) {
	st := &fakeStore{}
	mgr := New(Deps{Store: st})
	_, err := mgr.ListUnread(context.Background(), ListFilter{
		Limit: MaxListLimit + 100,
		Types: []domain.NotificationType{domain.NotificationMainCIRed},
	})
	if err != nil {
		t.Fatalf("ListUnread: %v", err)
	}
	if st.listFilter.Limit != MaxListLimit || len(st.listFilter.Types) != 1 || st.listFilter.Types[0] != domain.NotificationMainCIRed {
		t.Fatalf("filter = %+v", st.listFilter)
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
	if len(st.excludeTypes) != len(domain.OperatorAttentionNotificationTypes()) {
		t.Fatalf("excludeTypes = %+v, want operator-attention types", st.excludeTypes)
	}
}

func TestListUnreadRequiresStore(t *testing.T) {
	_, err := New(Deps{}).ListUnread(context.Background(), ListFilter{})
	if err == nil {
		t.Fatal("want missing store error")
	}
}
