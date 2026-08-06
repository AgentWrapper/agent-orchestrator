package mobilebridge

import (
	"encoding/json"
	"fmt"
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
	a := PushDevice{InstallID: "inst-a", Token: "ExpoPushToken[a]", Platform: "android", DeviceName: "Pixel", CreatedAt: now, LastSeenAt: now}
	b := PushDevice{InstallID: "inst-b", Token: "ExpoPushToken[b]", Platform: "ios", DeviceName: "iPhone", CreatedAt: now, LastSeenAt: now}
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

	if err := reg.Delete("inst-a"); err != nil {
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
	first := PushDevice{InstallID: "inst-a", Token: "ExpoPushToken[a]", Platform: "android", CreatedAt: created, LastSeenAt: created}
	if err := reg.Upsert(first); err != nil {
		t.Fatalf("upsert first: %v", err)
	}
	// Re-register the same token (e.g. foreground refresh) with a fresh CreatedAt;
	// the store must keep the ORIGINAL CreatedAt and only advance LastSeenAt.
	again := PushDevice{InstallID: "inst-a", Token: "ExpoPushToken[a]", Platform: "android", DeviceName: "renamed", CreatedAt: later, LastSeenAt: later}
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
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "ExpoPushToken[a]", CreatedAt: now, LastSeenAt: now}); err != nil {
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
	if err := reg.Delete("missing-install-id"); err != nil {
		t.Fatalf("delete missing install id should be a no-op, got %v", err)
	}
}

func TestUpsertKeysByInstallIDAndPreservesMute(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	created := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := reg.Upsert(PushDevice{
		InstallID: "inst-1", Token: "ExponentPushToken[a]", DeviceName: "Phone",
		CreatedAt: created, LastSeenAt: created,
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.SetMuted("inst-1", true); err != nil {
		t.Fatalf("mute: %v", err)
	}

	// The phone reinstalls: same install ID, brand new push token.
	later := created.Add(48 * time.Hour)
	if err := reg.Upsert(PushDevice{
		InstallID: "inst-1", Token: "ExponentPushToken[b]", DeviceName: "Phone",
		CreatedAt: later, LastSeenAt: later,
	}); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}

	devices := reg.List()
	if len(devices) != 1 {
		t.Fatalf("devices = %d, want 1 (reinstall must not duplicate)", len(devices))
	}
	got := devices[0]
	if got.Token != "ExponentPushToken[b]" {
		t.Fatalf("token = %q, want the new one", got.Token)
	}
	if !got.Muted {
		t.Fatalf("mute did not survive re-registration")
	}
	if !got.CreatedAt.Equal(created) {
		t.Fatalf("CreatedAt = %v, want original %v", got.CreatedAt, created)
	}
}

func TestUpsertAdoptsLegacyRowByToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	legacy := `{"devices":[{"token":"ExponentPushToken[a]","platform":"ios","deviceName":"iPhone","createdAt":"2026-01-01T00:00:00Z","lastSeenAt":"2026-01-02T00:00:00Z"}]}`
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	migrated := reg.List()
	if len(migrated) != 1 || migrated[0].InstallID == "" {
		t.Fatalf("migration did not synthesize an install ID: %+v", migrated)
	}
	if err := reg.SetMuted(migrated[0].InstallID, true); err != nil {
		t.Fatalf("mute: %v", err)
	}

	// That same phone now registers with its real install ID and same token.
	if err := reg.Upsert(PushDevice{
		InstallID: "real-inst", Token: "ExponentPushToken[a]", DeviceName: "iPhone",
		CreatedAt: time.Now().UTC(), LastSeenAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	devices := reg.List()
	if len(devices) != 1 {
		t.Fatalf("devices = %d, want 1 (adoption must not duplicate)", len(devices))
	}
	if devices[0].InstallID != "real-inst" {
		t.Fatalf("InstallID = %q, want the adopted real one", devices[0].InstallID)
	}
	if !devices[0].Muted {
		t.Fatalf("adoption lost the mute flag")
	}
	want := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !devices[0].CreatedAt.Equal(want) {
		t.Fatalf("CreatedAt = %v, want preserved %v", devices[0].CreatedAt, want)
	}
}

func TestDeleteByTokenAndByInstallID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, _ := LoadRegistry(path)
	now := time.Now().UTC()
	_ = reg.Upsert(PushDevice{InstallID: "i1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now})
	_ = reg.Upsert(PushDevice{InstallID: "i2", Token: "ExponentPushToken[b]", CreatedAt: now, LastSeenAt: now})

	if err := reg.DeleteByToken("ExponentPushToken[a]"); err != nil {
		t.Fatalf("delete by token: %v", err)
	}
	if err := reg.Delete("i2"); err != nil {
		t.Fatalf("delete by install id: %v", err)
	}
	if got := reg.List(); len(got) != 0 {
		t.Fatalf("devices = %+v, want empty", got)
	}
	if err := reg.Delete("missing"); err != nil {
		t.Fatalf("deleting unknown install id must be a no-op, got %v", err)
	}
}

func TestRemovedDeviceReturnsMuted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.Delete("inst-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if !got[0].Muted {
		t.Fatalf("device returned after removal is not muted: %+v", got[0])
	}
}

func TestRemovedDeviceMatchedByTokenReturnsMuted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.Delete("inst-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	// A reinstall looks like the same push token under a brand new install ID.
	reinstalled := PushDevice{InstallID: "inst-2", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(reinstalled); err != nil {
		t.Fatalf("upsert reinstalled: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if !got[0].Muted {
		t.Fatalf("reinstalled device matched by token is not muted: %+v", got[0])
	}
}

func TestTombstoneConsumedOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.Delete("inst-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	if got := reg.List(); len(got) != 1 || !got[0].Muted {
		t.Fatalf("expected device muted after removal, got %+v", got)
	}
	if err := reg.SetMuted("inst-1", false); err != nil {
		t.Fatalf("unmute: %v", err)
	}
	// A further registration must NOT be re-muted: the tombstone was already
	// consumed by the previous match. A surviving tombstone would silently
	// override the user's deliberate unmute.
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert again: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if got[0].Muted {
		t.Fatalf("tombstone re-muted a device the user had unmuted: %+v", got[0])
	}
}

func TestDeleteByTokenWritesNoTombstone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.DeleteByToken("ExponentPushToken[a]"); err != nil {
		t.Fatalf("delete by token: %v", err)
	}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if got[0].Muted {
		t.Fatalf("DeleteByToken must not write a tombstone, but device came back muted: %+v", got[0])
	}
}

func TestTombstonesPersistAcrossReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-1", Token: "ExponentPushToken[a]", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if err := reg.Delete("inst-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}

	reloaded, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if err := reloaded.Upsert(dev); err != nil {
		t.Fatalf("re-upsert after reload: %v", err)
	}
	got := reloaded.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if !got[0].Muted {
		t.Fatalf("tombstone did not survive reload: %+v", got[0])
	}
}

func TestUpsertAcceptsDeviceWithoutToken(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	dev := PushDevice{InstallID: "inst-a", Token: "", Platform: "ios", DeviceName: "iPhone", CreatedAt: now, LastSeenAt: now}
	if err := reg.Upsert(dev); err != nil {
		t.Fatalf("upsert without token: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("list len = %d, want 1", len(got))
	}
	if got[0].InstallID != "inst-a" || got[0].Token != "" {
		t.Fatalf("stored device = %+v, want tokenless inst-a", got[0])
	}
}

func TestUpsertStillRejectsMalformedToken(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "garbage"}); err == nil {
		t.Fatal("expected error upserting malformed token")
	}
	if got := reg.List(); len(got) != 0 {
		t.Fatalf("malformed upsert leaked a row: %+v", got)
	}
}

func TestTokenAttachesToExistingIdentityRow(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	// The phone announces its identity with no token (permission not yet granted).
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "", Platform: "ios", CreatedAt: now, LastSeenAt: now}); err != nil {
		t.Fatalf("announce: %v", err)
	}
	later := now.Add(time.Minute)
	// Permission is granted; the same install ID registers WITH a token.
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "ExponentPushToken[a]", Platform: "ios", CreatedAt: later, LastSeenAt: later}); err != nil {
		t.Fatalf("register with token: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1 (token must attach to the same row)", len(got))
	}
	if got[0].InstallID != "inst-a" || got[0].Token != "ExponentPushToken[a]" {
		t.Fatalf("device = %+v, want inst-a with the new token", got[0])
	}
}

func TestAnnounceDoesNotBlankExistingToken(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "ExponentPushToken[a]", Platform: "ios", CreatedAt: now, LastSeenAt: now}); err != nil {
		t.Fatalf("register with token: %v", err)
	}
	later := now.Add(time.Minute)
	// A later announce (e.g. app foregrounded) carries no token at all.
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "", Platform: "ios", CreatedAt: later, LastSeenAt: later}); err != nil {
		t.Fatalf("announce: %v", err)
	}
	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("devices = %d, want 1", len(got))
	}
	if got[0].Token != "ExponentPushToken[a]" {
		t.Fatalf("token = %q, want the original token to survive a tokenless announce", got[0].Token)
	}
}

func TestTokenlessAnnounceDoesNotAdoptByToken(t *testing.T) {
	reg, err := LoadRegistry(PushDevicesPath(t.TempDir()))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	if err := reg.Upsert(PushDevice{InstallID: "inst-a", Token: "", Platform: "ios", CreatedAt: now, LastSeenAt: now}); err != nil {
		t.Fatalf("announce a: %v", err)
	}
	if err := reg.Upsert(PushDevice{InstallID: "inst-b", Token: "", Platform: "android", CreatedAt: now, LastSeenAt: now}); err != nil {
		t.Fatalf("announce b: %v", err)
	}
	got := reg.List()
	if len(got) != 2 {
		t.Fatalf("devices = %d, want 2 (two distinct tokenless phones must not merge)", len(got))
	}
}

func TestTombstonesAreCapped(t *testing.T) {
	path := filepath.Join(t.TempDir(), "push-devices.json")
	reg, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	now := time.Now().UTC()
	const total = 60
	for i := 0; i < total; i++ {
		installID := fmt.Sprintf("inst-%03d", i)
		token := fmt.Sprintf("ExponentPushToken[%03d]", i)
		if err := reg.Upsert(PushDevice{InstallID: installID, Token: token, CreatedAt: now, LastSeenAt: now}); err != nil {
			t.Fatalf("upsert %d: %v", i, err)
		}
		if err := reg.Delete(installID); err != nil {
			t.Fatalf("delete %d: %v", i, err)
		}
	}

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var file pushDevicesFile
	if err := json.Unmarshal(b, &file); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(file.Removed) != maxTombstones {
		t.Fatalf("tombstones = %d, want %d", len(file.Removed), maxTombstones)
	}
	// The oldest (inst-000..inst-009) must have been dropped; the newest
	// (inst-050..inst-059) must remain.
	seen := map[string]bool{}
	for _, r := range file.Removed {
		seen[r.InstallID] = true
	}
	for i := 0; i < total-maxTombstones; i++ {
		installID := fmt.Sprintf("inst-%03d", i)
		if seen[installID] {
			t.Fatalf("oldest tombstone %q should have been dropped", installID)
		}
	}
	for i := total - maxTombstones; i < total; i++ {
		installID := fmt.Sprintf("inst-%03d", i)
		if !seen[installID] {
			t.Fatalf("newest tombstone %q should have been kept", installID)
		}
	}
}
