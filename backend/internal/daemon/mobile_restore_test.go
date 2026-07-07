package daemon

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/mobilebridge"
)

// fakeLAN is a minimal httpd.LANController fake for exercising
// restoreMobileOnBoot without a real listener.
type fakeLAN struct {
	started bool
	hash    string
	port    int
}

func (f *fakeLAN) Start(port int) (int, error) {
	f.started = true
	f.port = port
	return port, nil
}
func (f *fakeLAN) Stop(ctx context.Context) error { return nil }
func (f *fakeLAN) Running() bool                  { return f.started }
func (f *fakeLAN) BoundPort() int                 { return f.port }
func (f *fakeLAN) SetPasswordHash(hash string)     { f.hash = hash }

func TestRestoreEnabledStartsListener(t *testing.T) {
	dir := t.TempDir()
	path := mobilebridge.Path(dir)
	if err := mobilebridge.Save(path, mobilebridge.State{Enabled: true, PasswordHash: "h", LastPort: 3011}); err != nil {
		t.Fatalf("save state: %v", err)
	}
	lan := &fakeLAN{}
	restoreMobileOnBoot(path, lan)
	if !lan.started {
		t.Fatal("expected LAN listener started from persisted enabled state")
	}
	if lan.hash != "h" {
		t.Fatalf("expected persisted hash reused, got %q", lan.hash)
	}
	if lan.port != 3011 {
		t.Fatalf("expected persisted port reused, got %d", lan.port)
	}
}

func TestRestoreDisabledDoesNotStart(t *testing.T) {
	dir := t.TempDir()
	path := mobilebridge.Path(dir)
	if err := mobilebridge.Save(path, mobilebridge.State{Enabled: false}); err != nil {
		t.Fatalf("save state: %v", err)
	}
	lan := &fakeLAN{}
	restoreMobileOnBoot(path, lan)
	if lan.started {
		t.Fatal("expected LAN listener NOT started when persisted state is disabled")
	}
}
