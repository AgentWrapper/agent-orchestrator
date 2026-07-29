package cloud

import (
	"context"
	"errors"
	"testing"
)

// Share must refuse a session that isn't live: a terminated/provisioning/failed
// sandbox has no reachable preview to mint, so callers get ErrSessionNotShareable
// (→ 409) instead of an opaque 500 from a failed signed-URL mint.
func TestShare_RejectsNonReadySessions(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{})
	for _, status := range []string{StatusTerminated, StatusProvisioning, StatusFailed} {
		id := "sb-" + status
		s.sessions[id] = &CloudSession{SandboxID: id, SessionID: "s-1", Status: status}
		if _, err := s.Share(context.Background(), id, 0, "proj"); !errors.Is(err, ErrSessionNotShareable) {
			t.Fatalf("status %q: want ErrSessionNotShareable, got %v", status, err)
		}
	}
}

// An unknown sandbox yields (nil, nil) — the handler maps that to 404, distinct
// from the not-shareable 409.
func TestShare_UnknownSandboxIsNotFound(t *testing.T) {
	s := NewSupervisor(SupervisorConfig{})
	res, err := s.Share(context.Background(), "nope", 0, "proj")
	if res != nil || err != nil {
		t.Fatalf("want (nil, nil) for unknown sandbox, got (%v, %v)", res, err)
	}
}
