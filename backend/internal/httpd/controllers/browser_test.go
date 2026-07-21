package controllers_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
)

type fakeBrowserRuntime struct {
	status browserruntime.Status
	action string
	args   map[string]interface{}
	err    error
}

func (f *fakeBrowserRuntime) Status() browserruntime.Status { return f.status }

func (f *fakeBrowserRuntime) Execute(
	_ context.Context,
	_ domain.SessionID,
	action string,
	args map[string]interface{},
) (browserruntime.Result, error) {
	f.action, f.args = action, args
	if f.err != nil {
		return browserruntime.Result{}, f.err
	}
	return browserruntime.Result{RequestID: "request-1", Value: map[string]interface{}{"text": "button Save [ref=e1]"}}, nil
}

func browserServer(t *testing.T, runtime *fakeBrowserRuntime) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		Sessions: newFakeSessionService(),
		Browser:  runtime,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBrowserStatusAndSnapshot(t *testing.T) {
	connectedAt := time.Now().UTC().Truncate(time.Second)
	runtime := &fakeBrowserRuntime{status: browserruntime.Status{Connected: true, ConnectedAt: connectedAt}}
	srv := browserServer(t, runtime)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/browser/status?sessionId=ao-1", "")
	if status != http.StatusOK || !containsAll(body, `"connected":true`, `"transport":"electron-webcontents-debugger"`) {
		t.Fatalf("status = %d body=%s", status, body)
	}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/browser/commands", `{"sessionId":"ao-1","action":"snapshot","args":{"interactive":true}}`)
	if status != http.StatusOK || !containsAll(body, `"requestId":"request-1"`, `"button Save [ref=e1]"`) {
		t.Fatalf("command = %d body=%s", status, body)
	}
	if runtime.action != "snapshot" || runtime.args["interactive"] != true {
		t.Fatalf("runtime command = %q %#v", runtime.action, runtime.args)
	}
}

func TestBrowserCommandValidationAndErrors(t *testing.T) {
	runtime := &fakeBrowserRuntime{}
	srv := browserServer(t, runtime)

	body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/browser/commands", `{"sessionId":"ao-1","action":"eval"}`)
	if status != http.StatusBadRequest || !containsAll(body, `"code":"BROWSER_ACTION_UNSUPPORTED"`) {
		t.Fatalf("unsupported = %d body=%s", status, body)
	}
	runtime.err = browserruntime.ErrUnavailable
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/browser/commands", `{"sessionId":"ao-1","action":"snapshot"}`)
	if status != http.StatusServiceUnavailable || !containsAll(body, `"code":"BROWSER_RUNTIME_UNAVAILABLE"`) {
		t.Fatalf("unavailable = %d body=%s", status, body)
	}
	runtime.err = browserruntime.CommandError{Code: "STALE_REFERENCE", Message: "snapshot again"}
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/browser/commands", `{"sessionId":"ao-1","action":"click"}`)
	if status != http.StatusConflict || !containsAll(body, `"code":"STALE_REFERENCE"`) {
		t.Fatalf("stale = %d body=%s", status, body)
	}
}

func containsAll(body []byte, parts ...string) bool {
	value := string(body)
	for _, part := range parts {
		if !strings.Contains(value, part) {
			return false
		}
	}
	return true
}
