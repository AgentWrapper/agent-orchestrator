package presence

import (
	"testing"
	"time"
)

func TestLiveWithinTTLAndExpires(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	tr := NewTracker()
	tr.Now = func() time.Time { return now }

	tr.Touch("inst-1")
	if !tr.Live()["inst-1"] {
		t.Fatal("device should be live immediately after Touch")
	}

	now = now.Add(TTL - time.Second)
	if !tr.Live()["inst-1"] {
		t.Fatal("device should still be live just inside the TTL")
	}

	now = now.Add(2 * time.Second) // now just past the TTL
	if tr.Live()["inst-1"] {
		t.Fatal("device should have expired past the TTL")
	}
}

func TestTouchExtendsLiveness(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	tr := NewTracker()
	tr.Now = func() time.Time { return now }

	tr.Touch("inst-1")
	now = now.Add(TTL - time.Second)
	tr.Touch("inst-1") // the next poll lands before expiry
	now = now.Add(TTL - time.Second)
	if !tr.Live()["inst-1"] {
		t.Fatal("a second Touch should have extended liveness")
	}
}

func TestEmptyInstallIDIgnored(t *testing.T) {
	tr := NewTracker()
	tr.Touch("")
	if len(tr.Live()) != 0 {
		t.Fatalf("empty install id must not create an entry: %+v", tr.Live())
	}
}
