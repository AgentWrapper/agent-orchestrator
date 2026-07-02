package controllers_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeActivityRecorder struct {
	gotID     domain.SessionID
	gotSignal ports.ActivitySignal
	calls     int
	err       error
}

func (f *fakeActivityRecorder) ApplyActivitySignal(_ context.Context, id domain.SessionID, s ports.ActivitySignal) error {
	f.calls++
	f.gotID = id
	f.gotSignal = s
	return f.err
}

func newActivityTestServer(t *testing.T, rec *fakeActivityRecorder) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	deps := httpd.APIDeps{}
	if rec != nil {
		deps.Activity = rec
	}
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, deps, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSessionsAPI_ActivityAppliesSignal(t *testing.T) {
	rec := &fakeActivityRecorder{}
	srv := newActivityTestServer(t, rec)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{"state":"waiting_input"}`)
	if status != http.StatusOK {
		t.Fatalf("activity = %d, want 200; body=%s", status, body)
	}
	var resp struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionId"`
		State     string `json:"state"`
	}
	mustJSON(t, body, &resp)
	if !resp.OK || resp.SessionID != "ao-1" || resp.State != "waiting_input" {
		t.Fatalf("activity response = %#v", resp)
	}
	if rec.calls != 1 || rec.gotID != "ao-1" {
		t.Fatalf("recorder calls=%d id=%q", rec.calls, rec.gotID)
	}
	if !rec.gotSignal.Valid || rec.gotSignal.State != domain.ActivityWaitingInput {
		t.Fatalf("recorder signal = %#v", rec.gotSignal)
	}
}

func TestSessionsAPI_ActivityAcceptsBlocked(t *testing.T) {
	rec := &fakeActivityRecorder{}
	srv := newActivityTestServer(t, rec)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{"state":"blocked"}`)
	if status != http.StatusOK {
		t.Fatalf("activity = %d, want 200; body=%s", status, body)
	}
	if !rec.gotSignal.Valid || rec.gotSignal.State != domain.ActivityBlocked {
		t.Fatalf("recorder signal = %#v", rec.gotSignal)
	}
}

func TestSessionsAPI_ActivityRejectsUnknownState(t *testing.T) {
	rec := &fakeActivityRecorder{}
	srv := newActivityTestServer(t, rec)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{"state":"napping"}`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_ACTIVITY_STATE")
	if rec.calls != 0 {
		t.Fatalf("recorder should not be called for an invalid state; calls=%d", rec.calls)
	}
}

func TestSessionsAPI_ActivityRejectsBadJSON(t *testing.T) {
	srv := newActivityTestServer(t, &fakeActivityRecorder{})

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{`)
	assertErrorCode(t, body, status, http.StatusBadRequest, "INVALID_JSON")
}

func TestSessionsAPI_ActivityMissingSessionIs404(t *testing.T) {
	srv := newActivityTestServer(t, &fakeActivityRecorder{err: ports.ErrSessionNotFound})

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/missing/activity", `{"state":"idle"}`)
	assertErrorCode(t, body, status, http.StatusNotFound, "SESSION_NOT_FOUND")
}

func TestSessionsAPI_ActivityRecorderErrorIs500(t *testing.T) {
	srv := newActivityTestServer(t, &fakeActivityRecorder{err: errors.New("boom")})

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{"state":"exited"}`)
	assertErrorCode(t, body, status, http.StatusInternalServerError, "INTERNAL_ERROR")
}

func TestSessionsAPI_ActivityWithoutRecorderIs501(t *testing.T) {
	srv := newActivityTestServer(t, nil)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity", `{"state":"idle"}`)
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}
