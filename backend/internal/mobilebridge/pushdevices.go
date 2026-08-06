package mobilebridge

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PushDevice is one registered phone that should receive push notifications.
// InstallID is the unique key: a phone generates it once per install and keeps
// it across reinstalls of the JS bundle, so a rotated Expo push token updates
// the existing row instead of creating a second one. Muted devices stay
// registered and listed but are skipped by the dispatcher.
type PushDevice struct {
	InstallID  string    `json:"installId"`
	Token      string    `json:"token"`
	Platform   string    `json:"platform,omitempty"`
	DeviceName string    `json:"deviceName,omitempty"`
	Muted      bool      `json:"muted,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	LastSeenAt time.Time `json:"lastSeenAt"`
}

// pushDevicesFile is the on-disk shape, wrapped in a struct (rather than a bare
// array) so future fields can be added without breaking older files.
type pushDevicesFile struct {
	Devices []PushDevice `json:"devices"`
}

// expoPushTokenRE matches the two Expo push-token spellings with a non-empty body.
var expoPushTokenRE = regexp.MustCompile(`^Expo(nent)?PushToken\[[^\]]+\]$`)

// ValidPushToken reports whether tok is a well-formed Expo push token. The daemon
// rejects anything else before storing so garbage can't accumulate in the registry.
func ValidPushToken(tok string) bool {
	return expoPushTokenRE.MatchString(tok)
}

// PushDevicesPath returns the push-device registry location under the data dir
// (~/.ao/mobile/push-devices.json), co-located with the Connect Mobile config.
func PushDevicesPath(dataDir string) string {
	return filepath.Join(dataDir, "mobile", "push-devices.json")
}

// DeviceRegistry is the in-memory, mutex-guarded push-device registry backed by a
// JSON file. Reads (List) serve the push dispatcher's hot path without touching
// disk; mutations (Upsert/Delete) persist the whole file atomically.
type DeviceRegistry struct {
	mu      sync.RWMutex
	path    string
	devices map[string]PushDevice // keyed by Token
}

// LoadRegistry reads the registry at path into memory, keyed by install ID. A
// missing file is not an error: it yields an empty registry. Rows written before
// install IDs existed get one synthesized here and the file is rewritten once, so
// the key is never empty at runtime.
func LoadRegistry(path string) (*DeviceRegistry, error) {
	reg := &DeviceRegistry{path: path, devices: map[string]PushDevice{}}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return reg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read push devices: %w", err)
	}
	var file pushDevicesFile
	if err := json.Unmarshal(b, &file); err != nil {
		return nil, fmt.Errorf("parse push devices: %w", err)
	}
	migrated := false
	for _, d := range file.Devices {
		if d.Token == "" {
			continue
		}
		if d.InstallID == "" {
			d.InstallID = "legacy-" + uuid.NewString()
			migrated = true
		}
		reg.devices[d.InstallID] = d
	}
	if migrated {
		reg.mu.Lock()
		err := reg.persistLocked()
		reg.mu.Unlock()
		if err != nil {
			return nil, fmt.Errorf("persist migrated push devices: %w", err)
		}
	}
	return reg, nil
}

// Upsert registers or refreshes a device. It resolves the target row in three
// steps: an existing row with the same InstallID; failing that, a row carrying
// the same push token (a legacy row adopting its real install ID exactly once);
// failing that, a new row. CreatedAt and Muted always survive, so neither a
// reinstall nor a token rotation can silently unmute a device.
func (r *DeviceRegistry) Upsert(dev PushDevice) error {
	if !ValidPushToken(dev.Token) {
		return fmt.Errorf("invalid push token %q", dev.Token)
	}
	if dev.InstallID == "" {
		return fmt.Errorf("install id required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, ok := r.devices[dev.InstallID]; ok {
		dev.CreatedAt, dev.Muted = carryOver(existing, dev)
		r.devices[dev.InstallID] = dev
		return r.persistLocked()
	}
	for key, existing := range r.devices {
		if existing.Token != dev.Token {
			continue
		}
		dev.CreatedAt, dev.Muted = carryOver(existing, dev)
		delete(r.devices, key) // re-key from the legacy/synthesized id
		r.devices[dev.InstallID] = dev
		return r.persistLocked()
	}
	r.devices[dev.InstallID] = dev
	return r.persistLocked()
}

// carryOver preserves the fields an incoming registration must never reset.
func carryOver(existing, incoming PushDevice) (time.Time, bool) {
	created := incoming.CreatedAt
	if !existing.CreatedAt.IsZero() {
		created = existing.CreatedAt
	}
	return created, existing.Muted
}

// Delete removes a device by install ID (the desktop's remove action). Deleting
// an unknown id is a no-op.
func (r *DeviceRegistry) Delete(installID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.devices[installID]; !ok {
		return nil
	}
	delete(r.devices, installID)
	return r.persistLocked()
}

// DeleteByToken removes a device by push token. Used by the phone's
// unregister-on-disconnect and by the dispatcher's dead-token pruning, neither
// of which knows an install ID. Unknown tokens are a no-op.
func (r *DeviceRegistry) DeleteByToken(token string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for key, dev := range r.devices {
		if dev.Token == token {
			delete(r.devices, key)
			return r.persistLocked()
		}
	}
	return nil
}

// SetMuted flips a device's mute flag. Unknown install ids return an error so
// the API can answer 404 rather than silently succeeding.
func (r *DeviceRegistry) SetMuted(installID string, muted bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	dev, ok := r.devices[installID]
	if !ok {
		return fmt.Errorf("unknown device %q", installID)
	}
	dev.Muted = muted
	r.devices[installID] = dev
	return r.persistLocked()
}

// List returns a snapshot of all registered devices, sorted by CreatedAt (then
// token) for stable output. The push dispatcher iterates this per event.
func (r *DeviceRegistry) List() []PushDevice {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]PushDevice, 0, len(r.devices))
	for _, d := range r.devices {
		out = append(out, d)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].Token < out[j].Token
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out
}

// persistLocked writes the current device set to disk atomically (temp file +
// rename, 0600), creating the parent dir if needed. Callers must hold r.mu.
func (r *DeviceRegistry) persistLocked() error {
	devices := make([]PushDevice, 0, len(r.devices))
	for _, d := range r.devices {
		devices = append(devices, d)
	}
	sort.Slice(devices, func(i, j int) bool { return devices[i].Token < devices[j].Token })

	b, err := json.MarshalIndent(pushDevicesFile{Devices: devices}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return fmt.Errorf("mkdir mobile dir: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.path), ".push-devices-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, r.path)
}
