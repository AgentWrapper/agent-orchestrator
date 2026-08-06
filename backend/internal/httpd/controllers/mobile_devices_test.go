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

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
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

func TestRosterRoutesBlockedOnLANListener(t *testing.T) {
	for _, path := range []string{"/api/v1/mobile/devices", "/api/v1/mobile/devices/i1"} {
		if !httpd.IsLANControlBlockedPathForTest(path) {
			t.Fatalf("%s must be blocked on the LAN listener — a phone must not read or change the roster", path)
		}
	}
}
