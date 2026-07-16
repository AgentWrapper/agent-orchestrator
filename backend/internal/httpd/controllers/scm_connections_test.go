package controllers_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	scmconnectionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/scmconnection"
)

type fakeSCMConnectionManager struct {
	connection scmconnectionsvc.Connection
	list       []scmconnectionsvc.Connection
	result     scmconnectionsvc.TestResult
	err        error
	created    scmconnectionsvc.CreateInput
	updatedID  string
	updated    scmconnectionsvc.UpdateInput
	deletedID  string
	testedID   string
}

func (f *fakeSCMConnectionManager) Create(_ context.Context, in scmconnectionsvc.CreateInput) (scmconnectionsvc.Connection, error) {
	f.created = in
	return f.connection, f.err
}

func (f *fakeSCMConnectionManager) List(context.Context) ([]scmconnectionsvc.Connection, error) {
	return f.list, f.err
}

func (f *fakeSCMConnectionManager) Get(context.Context, string) (scmconnectionsvc.Connection, error) {
	return f.connection, f.err
}

func (f *fakeSCMConnectionManager) Update(_ context.Context, id string, in scmconnectionsvc.UpdateInput) (scmconnectionsvc.Connection, error) {
	f.updatedID, f.updated = id, in
	return f.connection, f.err
}

func (f *fakeSCMConnectionManager) Delete(_ context.Context, id string) error {
	f.deletedID = id
	return f.err
}

func (f *fakeSCMConnectionManager) Test(_ context.Context, id string) (scmconnectionsvc.TestResult, error) {
	f.testedID = id
	return f.result, f.err
}

func newSCMConnectionServer(t *testing.T, manager scmconnectionsvc.Manager) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{
		SCMConnections: manager,
	}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSCMConnectionRoutesCRUDAndWriteOnlyToken(t *testing.T) {
	connection := scmconnectionsvc.Connection{
		ID: "gitlab-work", Provider: domain.SCMProviderGitLab, DisplayName: "Work",
		WebBaseURL: "https://gitlab.example.com", APIBaseURL: "https://gitlab.example.com/api/v4",
		CredentialConfigured: true, Status: scmconnectionsvc.StatusUnknown,
	}
	mgr := &fakeSCMConnectionManager{connection: connection, list: []scmconnectionsvc.Connection{connection}}
	srv := newSCMConnectionServer(t, mgr)

	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/scm/connections", "")
	if status != http.StatusOK || !strings.Contains(string(body), `"connections"`) {
		t.Fatalf("list = %d %s", status, body)
	}
	assertNoSCMSecrets(t, body)

	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/scm/connections", `{"id":"gitlab-work","provider":"gitlab","displayName":"Work","token":"write-only"}`)
	if status != http.StatusCreated || !mgr.created.Token.Present || mgr.created.Token.Value != "write-only" {
		t.Fatalf("create = %d %s input=%#v", status, body, mgr.created)
	}
	assertNoSCMSecrets(t, body)

	body, status, _ = doRequest(t, srv, http.MethodGet, "/api/v1/scm/connections/gitlab-work", "")
	if status != http.StatusOK || !strings.Contains(string(body), `"connection"`) {
		t.Fatalf("get = %d %s", status, body)
	}
	assertNoSCMSecrets(t, body)

	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/scm/connections/gitlab-work", `{"provider":"gitlab","displayName":"Renamed"}`)
	if status != http.StatusOK || mgr.updatedID != "gitlab-work" || mgr.updated.Token.Present {
		t.Fatalf("update omitted token = %d %s input=%#v", status, body, mgr.updated)
	}

	body, status, _ = doRequest(t, srv, http.MethodPut, "/api/v1/scm/connections/gitlab-work", `{"provider":"gitlab","displayName":"Renamed","token":""}`)
	if status != http.StatusOK || !mgr.updated.Token.Present || mgr.updated.Token.Value != "" {
		t.Fatalf("update empty token = %d %s input=%#v", status, body, mgr.updated)
	}

	body, status, _ = doRequest(t, srv, http.MethodDelete, "/api/v1/scm/connections/gitlab-work", "")
	if status != http.StatusNoContent || len(body) != 0 || mgr.deletedID != "gitlab-work" {
		t.Fatalf("delete = %d %q id=%q", status, body, mgr.deletedID)
	}
}

func TestSCMConnectionTestRouteReturnsNormalizedStatuses(t *testing.T) {
	statuses := []string{
		scmconnectionsvc.StatusConnected,
		scmconnectionsvc.StatusMissingCredential,
	}
	for _, testStatus := range statuses {
		t.Run(testStatus, func(t *testing.T) {
			mgr := &fakeSCMConnectionManager{result: scmconnectionsvc.TestResult{
				Status:       testStatus,
				Identity:     scmconnectionsvc.Identity{Username: "alice"},
				Capabilities: scmconnectionsvc.Capabilities{Read: true, Write: testStatus == scmconnectionsvc.StatusConnected},
			}}
			srv := newSCMConnectionServer(t, mgr)
			body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/scm/connections/gitlab-work/test", "")
			if status != http.StatusOK || mgr.testedID != "gitlab-work" {
				t.Fatalf("test = %d %s id=%q", status, body, mgr.testedID)
			}
			var got struct {
				Result scmconnectionsvc.TestResult `json:"result"`
			}
			mustJSON(t, body, &got)
			if got.Result.Status != testStatus || got.Result.Identity.Username != "alice" {
				t.Fatalf("result = %#v", got.Result)
			}
			assertNoSCMSecrets(t, body)
		})
	}
}

func TestSCMConnectionRoutesStrictJSONAndErrorMapping(t *testing.T) {
	mgr := &fakeSCMConnectionManager{}
	srv := newSCMConnectionServer(t, mgr)

	for _, tc := range []struct {
		name, method, path, request, code string
		status                            int
	}{
		{name: "invalid create json", method: http.MethodPost, path: "/api/v1/scm/connections", request: `{`, status: 400, code: "INVALID_JSON"},
		{name: "unknown create field", method: http.MethodPost, path: "/api/v1/scm/connections", request: `{"id":"x","provider":"gitlab","displayName":"x","credentialRef":"bad"}`, status: 400, code: "INVALID_JSON"},
		{name: "null create token", method: http.MethodPost, path: "/api/v1/scm/connections", request: `{"id":"x","provider":"gitlab","displayName":"x","token":null}`, status: 400, code: "INVALID_JSON"},
		{name: "trailing create value", method: http.MethodPost, path: "/api/v1/scm/connections", request: `{"id":"x","provider":"gitlab","displayName":"x"} {}`, status: 400, code: "INVALID_JSON"},
		{name: "unknown update field", method: http.MethodPut, path: "/api/v1/scm/connections/x", request: `{"provider":"gitlab","displayName":"x","credentialRef":"bad"}`, status: 400, code: "INVALID_JSON"},
		{name: "null update token", method: http.MethodPut, path: "/api/v1/scm/connections/x", request: `{"provider":"gitlab","displayName":"x","token":null}`, status: 400, code: "INVALID_JSON"},
		{name: "trailing update value", method: http.MethodPut, path: "/api/v1/scm/connections/x", request: `{"provider":"gitlab","displayName":"x"} true`, status: 400, code: "INVALID_JSON"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, status, _ := doRequest(t, srv, tc.method, tc.path, tc.request)
			assertErrorCode(t, body, status, tc.status, tc.code)
		})
	}

	mgr.err = apierr.Conflict("SCM_CONNECTION_REFERENCED", "SCM connection is referenced", nil)
	body, status, _ := doRequest(t, srv, http.MethodDelete, "/api/v1/scm/connections/x", "")
	assertErrorCode(t, body, status, http.StatusConflict, "SCM_CONNECTION_REFERENCED")

	mgr.err = apierr.NotFound("SCM_CONNECTION_NOT_FOUND", "Unknown SCM connection")
	body, status, _ = doRequest(t, srv, http.MethodGet, "/api/v1/scm/connections/x", "")
	assertErrorCode(t, body, status, http.StatusNotFound, "SCM_CONNECTION_NOT_FOUND")

	mgr.err = apierr.Internal("SCM_CONNECTION_TEST_FAILED", "Failed to test SCM connection")
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/scm/connections/x/test", "")
	assertErrorCode(t, body, status, http.StatusInternalServerError, "SCM_CONNECTION_TEST_FAILED")
	if strings.Contains(string(body), "provider body") {
		t.Fatalf("provider response leaked: %s", body)
	}

	mgr.err = apierr.Conflict("SCM_CONNECTION_TEST_STALE", "SCM connection changed while the test was running", nil)
	body, status, _ = doRequest(t, srv, http.MethodPost, "/api/v1/scm/connections/x/test", "")
	assertErrorCode(t, body, status, http.StatusConflict, "SCM_CONNECTION_TEST_STALE")

	for _, tc := range []struct {
		name   string
		kind   apierr.Kind
		code   string
		status int
	}{
		{name: "auth", kind: apierr.KindUnauthorized, code: "SCM_AUTH_FAILED", status: http.StatusUnauthorized},
		{name: "forbidden", kind: apierr.KindForbidden, code: "SCM_FORBIDDEN", status: http.StatusForbidden},
		{name: "unreachable", kind: apierr.KindUnavailable, code: "SCM_INSTANCE_UNREACHABLE", status: http.StatusServiceUnavailable},
		{name: "TLS", kind: apierr.KindUnavailable, code: "SCM_TLS_FAILED", status: http.StatusServiceUnavailable},
		{name: "rate limited", kind: apierr.KindRateLimited, code: "SCM_RATE_LIMITED", status: http.StatusTooManyRequests},
		{name: "repo missing", kind: apierr.KindNotFound, code: "SCM_REPO_NOT_FOUND", status: http.StatusNotFound},
		{name: "write scope", kind: apierr.KindForbidden, code: "SCM_WRITE_SCOPE_MISSING", status: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mgr.err = apierr.New(tc.kind, tc.code, "redacted", nil)
			body, status, _ := doRequest(t, srv, http.MethodPost, "/api/v1/scm/connections/x/test", "")
			assertErrorCode(t, body, status, tc.status, tc.code)
		})
	}
}

func TestSCMConnectionRoutesDefaultToStubs(t *testing.T) {
	srv := newSCMConnectionServer(t, nil)
	body, status, _ := doRequest(t, srv, http.MethodGet, "/api/v1/scm/connections", "")
	assertErrorCode(t, body, status, http.StatusNotImplemented, "NOT_IMPLEMENTED")
}

func assertNoSCMSecrets(t *testing.T, body []byte) {
	t.Helper()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatalf("response is not JSON: %v; body=%s", err, body)
	}
	lower := strings.ToLower(string(body))
	for _, forbidden := range []string{"token", "credentialref", "write-only"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("response contains %q: %s", forbidden, body)
		}
	}
}
