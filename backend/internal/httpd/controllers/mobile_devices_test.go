package controllers_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
	"github.com/aoagents/agent-orchestrator/backend/internal/presence"
)

type fakeRoster struct {
	devices []mobilebridge.PushDevice
	muted   map[string]bool
	deleted []string
}

func (f *fakeRoster) List() []mobilebridge.PushDevice { return f.devices }

func (f *fakeRoster) SetMuted(installID string, muted bool) error {
	if f.muted == nil {
		f.muted = map[string]bool{}
	}
	f.muted[installID] = muted
	return nil
}

func (f *fakeRoster) Delete(installID string) error {
	f.deleted = append(f.deleted, installID)
	return nil
}

type fakeLive map[string]bool

func (f fakeLive) Live() map[string]bool { return f }

func newRosterServer(t *testing.T, roster *fakeRoster, live fakeLive) *httptest.Server {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log,
		nil, httpd.APIDeps{DeviceRoster: roster, DeviceLive: live}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestListDevicesMergesLiveFlag(t *testing.T) {
	now := time.Now().UTC()
	roster := &fakeRoster{devices: []mobilebridge.PushDevice{
		{InstallID: "i1", Token: "ExponentPushToken[a]", DeviceName: "iPhone", CreatedAt: now, LastSeenAt: now},
		{InstallID: "i2", Token: "ExponentPushToken[b]", DeviceName: "M31s", Muted: true, CreatedAt: now, LastSeenAt: now},
	}}
	srv := newRosterServer(t, roster, fakeLive{"i1": true})

	res, err := http.Get(srv.URL + "/api/v1/mobile/devices")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}

	var env struct {
		Devices []struct {
			InstallID string `json:"installId"`
			Live      bool   `json:"live"`
			Muted     bool   `json:"muted"`
		} `json:"devices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(env.Devices) != 2 {
		t.Fatalf("devices = %d, want 2", len(env.Devices))
	}
	byID := map[string]struct{ live, muted bool }{}
	for _, d := range env.Devices {
		byID[d.InstallID] = struct{ live, muted bool }{d.Live, d.Muted}
	}
	if !byID["i1"].live {
		t.Fatal("i1 should be live")
	}
	if byID["i2"].live {
		t.Fatal("i2 should be offline")
	}
	if !byID["i2"].muted {
		t.Fatal("i2 should report muted")
	}
}

// TestListDevicesFallsBackToPresenceWhenDeviceLiveOmitted exercises the
// wiring fix end-to-end: a caller (like daemon.go) that sets APIDeps.Presence
// but leaves DeviceLive nil must still get correct liveness in the roster,
// because NewRouterWithControl normalizes DeviceLive from Presence before the
// roster controller is constructed. This is the regression the structural fix
// in normalizeAPIDeps closes — without it, i1 below would incorrectly report
// offline.
func TestListDevicesFallsBackToPresenceWhenDeviceLiveOmitted(t *testing.T) {
	now := time.Now().UTC()
	roster := &fakeRoster{devices: []mobilebridge.PushDevice{
		{InstallID: "i1", Token: "ExponentPushToken[a]", DeviceName: "iPhone", CreatedAt: now, LastSeenAt: now},
	}}
	tracker := presence.NewTracker()
	tracker.Touch("i1")

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log,
		nil, httpd.APIDeps{DeviceRoster: roster, Presence: tracker}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	res, err := http.Get(srv.URL + "/api/v1/mobile/devices")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}

	var env struct {
		Devices []struct {
			InstallID string `json:"installId"`
			Live      bool   `json:"live"`
		} `json:"devices"`
	}
	if err := json.NewDecoder(res.Body).Decode(&env); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(env.Devices) != 1 || !env.Devices[0].Live {
		t.Fatalf("devices = %+v, want i1 live via the Presence fallback", env.Devices)
	}
}

func TestMuteDevice(t *testing.T) {
	roster := &fakeRoster{}
	srv := newRosterServer(t, roster, fakeLive{})

	req, _ := http.NewRequest(http.MethodPatch, srv.URL+"/api/v1/mobile/devices/i1",
		strings.NewReader(`{"muted":true}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if !roster.muted["i1"] {
		t.Fatalf("muted = %+v, want i1 true", roster.muted)
	}
}

// TestMobileDeviceRoutesUnavailableWithoutRegistry pins the human ruling that
// supersedes the brief's nil-guard: the roster routes always mount, and when
// the device registry failed to load (deps.DeviceRoster is nil), each of
// List/Mute/Remove answers 503 with code DEVICE_REGISTRY_UNAVAILABLE rather
// than 404 (route missing) or a panic (nil dereference). This lets the desktop
// tell "your registry is broken" apart from "this daemon predates the roster
// feature".
func TestMobileDeviceRoutesUnavailableWithoutRegistry(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(httpd.NewRouterWithControl(config.Config{}, log,
		nil, httpd.APIDeps{DeviceRoster: nil, DeviceLive: fakeLive{}}, httpd.ControlDeps{}))
	t.Cleanup(srv.Close)

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"list", http.MethodGet, "/api/v1/mobile/devices", ""},
		{"mute", http.MethodPatch, "/api/v1/mobile/devices/i1", `{"muted":true}`},
		{"remove", http.MethodDelete, "/api/v1/mobile/devices/i1", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req, err := http.NewRequest(tc.method, srv.URL+tc.path, body)
			if err != nil {
				t.Fatalf("new request: %v", err)
			}
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("%s: %v", tc.method, err)
			}
			defer res.Body.Close()
			if res.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", res.StatusCode)
			}
			var apiErr struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(res.Body).Decode(&apiErr); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if apiErr.Code != "DEVICE_REGISTRY_UNAVAILABLE" {
				t.Fatalf("code = %q, want DEVICE_REGISTRY_UNAVAILABLE", apiErr.Code)
			}
		})
	}
}

func TestDeleteDevice(t *testing.T) {
	roster := &fakeRoster{}
	srv := newRosterServer(t, roster, fakeLive{})

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/v1/mobile/devices/i1", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 200/204", res.StatusCode)
	}
	if len(roster.deleted) != 1 || roster.deleted[0] != "i1" {
		t.Fatalf("deleted = %+v, want [i1]", roster.deleted)
	}
}

// TestRosterRoutesBlockedOnLANListener pins isLANControlBlockedPath's decision
// for these two literal paths, so it catches deletion of the "/api/v1/mobile"
// entry from lanControlBlockedPrefixes. It is intentionally decoupled from
// what mountMobileDevices actually mounts, so it CANNOT catch the roster
// routes being moved or aliased off the /api/v1/mobile prefix (e.g. to
// /api/v1/devices) — that class of regression is covered instead by
// TestRosterMountedRoutesAreLANBlocked below, which walks the live router.
// It also never drives lanControlBlock or authMiddleware ordering on a real
// socket — TestLANManagerBlocksLoopbackOnlyControlRoutes in
// lan_listener_test.go covers that end-to-end.
func TestRosterRoutesBlockedOnLANListener(t *testing.T) {
	for _, path := range []string{"/api/v1/mobile/devices", "/api/v1/mobile/devices/i1"} {
		if !httpd.IsLANControlBlockedPathForTest(path) {
			t.Fatalf("%s must be blocked on the LAN listener — a phone must not read or change the roster", path)
		}
	}
}

// TestRosterMountedRoutesAreLANBlocked walks the actual routes
// mountMobileDevices registers on the real router and asserts every one of
// them is reported blocked by isLANControlBlockedPath. Unlike
// TestRosterRoutesBlockedOnLANListener (which restates two path literals),
// this test fails if the roster routes are ever moved or aliased off the
// /api/v1/mobile prefix, since it derives its path list from the router
// itself rather than from a hardcoded string.
func TestRosterMountedRoutesAreLANBlocked(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := httpd.NewRouterWithControl(config.Config{}, log, nil,
		httpd.APIDeps{DeviceRoster: &fakeRoster{}, DeviceLive: fakeLive{}}, httpd.ControlDeps{})

	checked := 0
	err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1/mobile/devices") {
			return nil
		}
		checked++
		concrete := strings.ReplaceAll(route, "{installId}", "i1")
		if !httpd.IsLANControlBlockedPathForTest(concrete) {
			t.Errorf("%s %s is mounted but not blocked on the LAN listener", method, concrete)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk router: %v", err)
	}
	if checked == 0 {
		t.Fatal("no /api/v1/mobile/devices routes were mounted — router wiring changed?")
	}
}
