package controllers_test

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	notificationsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/notification"
)

type fakeNotificationService struct {
	gotFilter    notificationsvc.ListFilter
	gotMarkID    string
	items        []notificationsvc.Notification
	markItem     notificationsvc.Notification
	markAllCount int64
	err          error
}

type fakeNotificationStream struct {
	gotProject domain.ProjectID
	ch         chan domain.NotificationRecord
}

func (f *fakeNotificationService) List(_ context.Context, filter notificationsvc.ListFilter) (notificationsvc.ListPage, error) {
	f.gotFilter = filter
	return notificationsvc.ListPage{Notifications: f.items, NextCursor: "next-page", UnreadCount: 7}, f.err
}

func (f *fakeNotificationService) MarkRead(_ context.Context, id string) (notificationsvc.Notification, bool, error) {
	f.gotMarkID = id
	return f.markItem, f.err == nil, f.err
}

func (f *fakeNotificationService) MarkAllRead(context.Context) (int64, error) {
	return f.markAllCount, f.err
}

func (f *fakeNotificationStream) Subscribe(projectID domain.ProjectID) (<-chan domain.NotificationRecord, func()) {
	f.gotProject = projectID
	if f.ch == nil {
		f.ch = make(chan domain.NotificationRecord, 1)
	}
	return f.ch, func() {}
}

func newNotificationTestServer(t *testing.T, svc controllers.NotificationService) *httptest.Server {
	t.Helper()
	return newNotificationStreamTestServer(t, svc, nil)
}

func newNotificationStreamTestServer(t *testing.T, svc controllers.NotificationService, stream controllers.NotificationStream) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Notifications: svc, NotificationStream: stream}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func notificationsvcNotFound() error {
	return apierr.NotFound("NOTIFICATION_NOT_FOUND", "Unknown unread notification")
}

func TestNotificationsAPI_ListUnread(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	svc := &fakeNotificationService{items: []notificationsvc.Notification{{
		NotificationRecord: domain.NotificationRecord{ID: "ntf_1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "checkout-flow needs input", Body: "The agent is waiting for your response.", Status: domain.NotificationUnread, CreatedAt: now},
		Target:             notificationsvc.Target{Kind: notificationsvc.TargetSession, SessionID: "mer-1"},
	}}}
	srv := newNotificationTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications?limit=10&cursor=previous-page", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.gotFilter.Limit != 10 {
		t.Fatalf("filter = %+v", svc.gotFilter)
	}
	if svc.gotFilter.Status != notificationsvc.ListUnread {
		t.Fatalf("status = %q, want unread", svc.gotFilter.Status)
	}
	if svc.gotFilter.Cursor != "previous-page" {
		t.Fatalf("cursor = %q, want previous-page", svc.gotFilter.Cursor)
	}
	var resp struct {
		Notifications []struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionId"`
			ProjectID string `json:"projectId"`
			Type      string `json:"type"`
			Status    string `json:"status"`
			Target    struct {
				Kind      string `json:"kind"`
				SessionID string `json:"sessionId"`
			} `json:"target"`
		} `json:"notifications"`
		NextCursor  string `json:"nextCursor"`
		UnreadCount int    `json:"unreadCount"`
	}
	mustJSON(t, body, &resp)
	if len(resp.Notifications) != 1 || resp.Notifications[0].ID != "ntf_1" ||
		resp.Notifications[0].Target.Kind != "session" || resp.NextCursor != "next-page" || resp.UnreadCount != 7 {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestNotificationsAPI_ListAllHistory(t *testing.T) {
	svc := &fakeNotificationService{}
	srv := newNotificationTestServer(t, svc)

	_, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications?status=all", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if svc.gotFilter.Status != notificationsvc.ListAll || svc.gotFilter.Limit != notificationsvc.DefaultListLimit {
		t.Fatalf("filter = %+v", svc.gotFilter)
	}
}

func TestNotificationsAPI_DefaultsAndCapsLimit(t *testing.T) {
	svc := &fakeNotificationService{}
	srv := newNotificationTestServer(t, svc)

	_, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications?limit=9999", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if svc.gotFilter.Limit != notificationsvc.MaxListLimit {
		t.Fatalf("limit = %d, want cap %d", svc.gotFilter.Limit, notificationsvc.MaxListLimit)
	}
}

func TestNotificationsAPI_RejectsUnsupportedStatus(t *testing.T) {
	srv := newNotificationTestServer(t, &fakeNotificationService{})

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications?status=read", "")
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_QUERY")
}

func TestNotificationsAPI_MarkRead(t *testing.T) {
	now := time.Date(2026, 6, 11, 10, 0, 0, 0, time.UTC)
	svc := &fakeNotificationService{markItem: notificationsvc.Notification{
		NotificationRecord: domain.NotificationRecord{
			ID: "ntf_1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput,
			Title: "checkout-flow needs input", Status: domain.NotificationRead, CreatedAt: now,
		},
		Target: notificationsvc.Target{Kind: notificationsvc.TargetSession, SessionID: "mer-1"},
	}}
	srv := newNotificationTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "PATCH", "/api/v1/notifications/ntf_1", `{"status":"read"}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	if svc.gotMarkID != "ntf_1" {
		t.Fatalf("gotMarkID = %q", svc.gotMarkID)
	}
	var resp struct {
		Notification struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Target struct {
				Kind string `json:"kind"`
			} `json:"target"`
		} `json:"notification"`
	}
	mustJSON(t, body, &resp)
	if resp.Notification.ID != "ntf_1" || resp.Notification.Status != "read" || resp.Notification.Target.Kind != "session" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestNotificationsAPI_MarkReadRejectsUnsupportedStatus(t *testing.T) {
	srv := newNotificationTestServer(t, &fakeNotificationService{})

	body, status, _ := doRequest(t, srv, "PATCH", "/api/v1/notifications/ntf_1", `{"status":"unread"}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_NOTIFICATION_STATUS")
}

func TestNotificationsAPI_MarkReadUnknownNotification(t *testing.T) {
	srv := newNotificationTestServer(t, &fakeNotificationService{err: notificationsvcNotFound()})

	body, status, _ := doRequest(t, srv, "PATCH", "/api/v1/notifications/missing", `{"status":"read"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "NOTIFICATION_NOT_FOUND")
}

func TestNotificationsAPI_MarkAllRead(t *testing.T) {
	svc := &fakeNotificationService{markAllCount: 123}
	srv := newNotificationTestServer(t, svc)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/notifications/read-all", "")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		Notifications []controllers.NotificationResponse `json:"notifications"`
		UpdatedCount  int64                              `json:"updatedCount"`
	}
	mustJSON(t, body, &resp)
	if len(resp.Notifications) != 0 || resp.UpdatedCount != 123 {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestNotificationsAPI_WithoutServiceIs501(t *testing.T) {
	srv := newNotificationTestServer(t, nil)

	body, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications", "")
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func TestNotificationsAPI_StreamCreatedNotifications(t *testing.T) {
	stream := &fakeNotificationStream{ch: make(chan domain.NotificationRecord, 1)}
	srv := newNotificationStreamTestServer(t, &fakeNotificationService{}, stream)

	resp, err := srv.Client().Get(srv.URL + "/api/v1/notifications/stream?projectId=mer")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	if stream.gotProject != "mer" {
		t.Fatalf("project filter = %q", stream.gotProject)
	}

	stream.ch <- domain.NotificationRecord{ID: "ntf_1", SessionID: "mer-1", ProjectID: "mer", Type: domain.NotificationNeedsInput, Title: "needs input", Status: domain.NotificationUnread, CreatedAt: time.Now()}
	reader := bufio.NewReader(resp.Body)
	eventLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	dataLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(eventLine) != "event: notification_created" || !strings.Contains(dataLine, `"id":"ntf_1"`) {
		t.Fatalf("eventLine=%q dataLine=%q", eventLine, dataLine)
	}
}

func TestNotificationsAPI_StreamWithoutPublisherIs501(t *testing.T) {
	srv := newNotificationStreamTestServer(t, &fakeNotificationService{}, nil)
	body, status, _ := doRequest(t, srv, "GET", "/api/v1/notifications/stream", "")
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}
