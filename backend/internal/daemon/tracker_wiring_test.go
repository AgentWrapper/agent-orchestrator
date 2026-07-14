package daemon

import (
	"io"
	"log/slog"
	"testing"
)

// TestTrackerForSession_NilInterfaceWhenNoToken is a regression test for issue #2685:
// `ao spawn --issue` panicked because the session service received a typed-nil
// *github.Tracker inside a non-nil ports.Tracker interface, which slipped past the
// `s.tracker == nil` guard in withIssueContext and dereferenced nil on Get.
//
// When no GitHub token is available, the tracker handed to the session service must be
// a true nil interface (so the guard fires), never a typed-nil concrete value — a
// typed-nil ports.Tracker would compare != nil here even though the concrete Tracker
// is nil, which is exactly the regression.
func TestTrackerForSession_NilInterfaceWhenNoToken(t *testing.T) {
	// EnvTokenSource falls back to GITHUB_TOKEN after AO_GITHUB_TOKEN, so clear
	// both — otherwise a CI/local shell with GITHUB_TOKEN set would make
	// newGitHubTracker return a valid tracker and the nil assertion false-fails.
	t.Setenv("AO_GITHUB_TOKEN", "")
	t.Setenv("GITHUB_TOKEN", "")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	tracker := trackerForSession(log)
	if tracker != nil {
		t.Fatalf("tracker = %T(%[1]v), want a true nil ports.Tracker interface when no token is configured", tracker)
	}
}
