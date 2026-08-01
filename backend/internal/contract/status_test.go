package contract

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

type statusFixture struct {
	Name    string        `json:"name"`
	Session SessionFacts  `json:"session"`
	PRs     []PRFacts     `json:"prs"`
	Want    SessionStatus `json:"want"`
}

func TestStatusFixtures(t *testing.T) {
	data, err := os.ReadFile("testdata/status_fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []statusFixture
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			fixture.Session.Now = now
			fixture.Session.NoSignalGrace = 90 * time.Second
			if got := DeriveSessionStatus(fixture.Session, fixture.PRs); got != fixture.Want {
				t.Fatalf("DeriveSessionStatus() = %q, want %q", got, fixture.Want)
			}
		})
	}
}

func TestNoSignalContract(t *testing.T) {
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	got := DeriveSessionStatus(SessionFacts{
		Activity:        ActivityIdle,
		SignalCapable:   true,
		FirstSignalSeen: false,
		LastActivityAt:  now.Add(-2 * time.Minute),
		Now:             now,
		NoSignalGrace:   90 * time.Second,
	}, nil)
	if got != StatusNoSignal {
		t.Fatalf("DeriveSessionStatus() = %q, want %q", got, StatusNoSignal)
	}
}
