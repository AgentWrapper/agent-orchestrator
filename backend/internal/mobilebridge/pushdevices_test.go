package mobilebridge

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestPushDevicesPath(t *testing.T) {
	got := PushDevicesPath("/data")
	want := filepath.Join("/data", "mobile", "push-devices.json")
	if got != want {
		t.Fatalf("path = %q want %q", got, want)
	}
}

func TestValidPushToken(t *testing.T) {
	valid := []string{
		"ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
		"ExpoPushToken[abc-123_DEF]",
	}
	for _, tok := range valid {
		if !ValidPushToken(tok) {
			t.Errorf("ValidPushToken(%q) = false, want true", tok)
		}
	}
	invalid := []string{
		"",
		"garbage",
		"ExponentPushToken[]",
		"fcm:some-raw-token",
		"ExponentPushToken[abc",
	}
	for _, tok := range invalid {
		if ValidPushToken(tok) {
			t.Errorf("ValidPushToken(%q) = true, want false", tok)
		}
	}
}

func TestLoadRegistryMissingIsEmpty(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := reg.List(); len(got) != 0 {
		t.Fatalf("fresh registry = %+v, want empty", got)
	}
}

func TestUpsertListDeleteRoundTrip(t *testing.T) {
	path := PushDevicesPath(t.TempDir())
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Date(2026, 7, 13, 12, 0, 0, 0, time.UTC)
	a := PushDevice{Token: "ExpoPushToken[a]", Platform: "android", DeviceName: "Pixel", CreatedAt: now, LastSeenAt: now}
	b := PushDevice{Token: "ExpoPushToken[b]", Platform: "ios", DeviceName: "iPhone", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(a); err != nil {
		t.Fatalf("upsert a: %v", err)
	}
	if err := reg.Upsert(b); err != nil {
		t.Fatalf("upsert b: %v", err)
	}
	if got := reg.List(); len(got) != 2 {
		t.Fatalf("list len = %d, want 2", len(got))
	}

	// Reload from disk: the two devices must survive a restart.
	reloaded, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := reloaded.List(); len(got) != 2 {
		t.Fatalf("reloaded list len = %d, want 2", len(got))
	}

	if err := reg.Delete("ExpoPushToken[a]"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got := reg.List()
	if len(got) != 1 || got[0].Token != "ExpoPushToken[b]" {
		t.Fatalf("after delete = %+v, want only b", got)
	}
}

func TestUpsertPreservesCreatedAt(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	created := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	later := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	first := PushDevice{Token: "ExpoPushToken[a]", Platform: "android", CreatedAt: created, LastSeenAt: created}
	if err := reg.Upsert(first); err != nil {
		t.Fatalf("upsert first: %v", err)
	}
	// Re-register the same token (e.g. foreground refresh) with a fresh CreatedAt;
	// the store must keep the ORIGINAL CreatedAt and only advance LastSeenAt.
	again := PushDevice{Token: "ExpoPushToken[a]", Platform: "android", DeviceName: "renamed", CreatedAt: later, LastSeenAt: later}
	if err := reg.Upsert(again); err != nil {
		t.Fatalf("upsert again: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("list len = %d, want 1 (idempotent upsert)", len(got))
	}
	if !got[0].CreatedAt.Equal(created) {
		t.Fatalf("CreatedAt = %v, want preserved %v", got[0].CreatedAt, created)
	}
	if !got[0].LastSeenAt.Equal(later) {
		t.Fatalf("LastSeenAt = %v, want advanced %v", got[0].LastSeenAt, later)
	}
	if got[0].DeviceName != "renamed" {
		t.Fatalf("DeviceName = %q, want updated to renamed", got[0].DeviceName)
	}
}

func TestUpsertRejectsInvalidToken(t *testing.T) {
	reg, _ := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err := reg.Upsert(PushDevice{Token: "garbage"}); err == nil {
		t.Fatal("expected error upserting invalid token")
	}
	if got := reg.List(); len(got) != 0 {
		t.Fatalf("invalid upsert leaked a row: %+v", got)
	}
}

func TestRegistryFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows does not honor Unix file-permission bits; os.Chmod only toggles
		// the read-only flag, so Stat reports 0666. The 0600 intent is a no-op there.
		t.Skip("file mode bits are not meaningful on Windows")
	}
	path := PushDevicesPath(t.TempDir())
	reg, _ := LoadRegistry(path)
	now := time.Now().UTC()
	if err := reg.Upsert(PushDevice{Token: "ExpoPushToken[a]", CreatedAt: now, LastSeenAt: now}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v want 0600", info.Mode().Perm())
	}
}

func TestDeleteMissingTokenIsNoop(t *testing.T) {
	reg, _ := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err := reg.Delete("ExpoPushToken[nope]"); err != nil {
		t.Fatalf("delete missing token should be a no-op, got %v", err)
	}
}
