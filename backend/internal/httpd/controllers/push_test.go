package controllers_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

type fakePushRegistry struct {
	upserts []mobilebridge.PushDevice
	deletes []string
	err     error
}

func (f *fakePushRegistry) Upsert(dev mobilebridge.PushDevice) error {
	if f.err != nil {
		return f.err
	}
	f.upserts = append(f.upserts, dev)
	return nil
}

func (f *fakePushRegistry) Delete(token string) error {
	if f.err != nil {
		return f.err
	}
	f.deletes = append(f.deletes, token)
	return nil
}

func newPushTestServer(t *testing.T, reg *fakePushRegistry) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{Push: reg}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestRegisterPushDevice(t *testing.T) {
	reg := &fakePushRegistry{}
	srv := newPushTestServer(t, reg)

	body := `{"token":"ExponentPushToken[abc]","platform":"android","deviceName":"Pixel"}`
	res, err := http.Post(srv.URL+"/api/v1/push/devices", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if len(reg.upserts) != 1 {
		t.Fatalf("upserts = %d, want 1", len(reg.upserts))
	}
	got := reg.upserts[0]
	if got.Token != "ExponentPushToken[abc]" || got.Platform != "android" || got.DeviceName != "Pixel" {
		t.Fatalf("upserted device = %+v", got)
	}
	if got.CreatedAt.IsZero() || got.LastSeenAt.IsZero() {
		t.Fatalf("timestamps not stamped: %+v", got)
	}

	var env struct {
		Device struct {
			Token string `json:"token"`
		} `json:"device"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if env.Device.Token != "ExponentPushToken[abc]" {
		t.Fatalf("response token = %q", env.Device.Token)
	}
}

func TestRegisterPushDeviceRejectsBadToken(t *testing.T) {
	reg := &fakePushRegistry{}
	srv := newPushTestServer(t, reg)

	res, err := http.Post(srv.URL+"/api/v1/push/devices", "application/json", strings.NewReader(`{"token":"garbage"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", res.StatusCode)
	}
	if len(reg.upserts) != 0 {
		t.Fatalf("bad token reached the registry: %+v", reg.upserts)
	}
}

func TestUnregisterPushDevice(t *testing.T) {
	reg := &fakePushRegistry{}
	srv := newPushTestServer(t, reg)

	// The Expo token's [ ] must be URL-encoded by the client; the daemon must
	// receive the decoded token.
	token := "ExponentPushToken[abc]"
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/v1/push/devices/"+url.PathEscape(token), nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if len(reg.deletes) != 1 || reg.deletes[0] != token {
		t.Fatalf("deletes = %+v, want [%q]", reg.deletes, token)
	}
}

func TestPushRoutesNotImplementedWithoutRegistry(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log, nil, httpd.APIDeps{}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	res, err := http.Post(srv.URL+"/api/v1/push/devices", "application/json", strings.NewReader(`{"token":"ExponentPushToken[abc]"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", res.StatusCode)
	}
}
