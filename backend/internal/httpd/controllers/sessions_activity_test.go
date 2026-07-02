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

func TestSessionsAPI_ActivityThreadsCorrelationFields(t *testing.T) {
	// The optional correlation fields ride into the signal (sanitized); a
	// body without them (old CLIs) keeps producing a plain state-only signal,
	// which the other tests in this file pin.
	rec := &fakeActivityRecorder{}
	srv := newActivityTestServer(t, rec)

	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity",
		`{"state":"active","event":"post-tool-use","toolName":"Bash","toolUseId":"toolu_42"}`)
	if status != http.StatusOK {
		t.Fatalf("activity = %d, want 200; body=%s", status, body)
	}
	want := ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Event: "post-tool-use", ToolName: "Bash", ToolUseID: "toolu_42"}
	if rec.gotSignal != want {
		t.Fatalf("recorder signal = %#v, want %#v", rec.gotSignal, want)
	}
}

func TestSessionsAPI_ActivityCapsOverlongCorrelationFields(t *testing.T) {
	// Overlong values are dropped, not truncated: a truncated id could never
	// match its pre/post counterpart, so an empty value (fail-safe: no
	// correlated clear) is strictly better.
	rec := &fakeActivityRecorder{}
	srv := newActivityTestServer(t, rec)

	long := make([]byte, 300)
	for i := range long {
		long[i] = 'a'
	}
	body, status, _ := doRequest(t, srv, "POST", "/api/v1/sessions/ao-1/activity",
		`{"state":"active","event":"post-tool-use","toolUseId":"`+string(long)+`"}`)
	if status != http.StatusOK {
		t.Fatalf("activity = %d, want 200; body=%s", status, body)
	}
	if rec.gotSignal.ToolUseID != "" {
		t.Fatalf("overlong toolUseId not dropped: %q", rec.gotSignal.ToolUseID)
	}
	if rec.gotSignal.Event != "post-tool-use" {
		t.Fatalf("in-bounds event dropped: %#v", rec.gotSignal)
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
