// Package presence tracks which mobile devices are currently running the app.
//
// Liveness is derived from the phone's existing REST poll rather than from any
// dedicated heartbeat or socket: every authenticated request carries the device's
// install id, and a request is proof the app is running. The mux WebSocket is
// deliberately not used — it is only open while the user is on a terminal screen,
// so it would report "viewing a terminal", not "app is open".
package presence

import (
	"sync"
	"time"
)

// TTL is how long a device stays live after its last request. The phone polls
// every 8s, so two intervals plus slack means one dropped request does not blink
// the dot off, while a backgrounded or killed app goes dark within 20s.
const TTL = 20 * time.Second

// Tracker records the last time each install id was seen. It holds no goroutines
// and no timers: expiry is computed at read time, so there is nothing to leak and
// nothing to shut down.
type Tracker struct {
	mu   sync.RWMutex
	seen map[string]time.Time

	// Now is the clock, injectable so tests control expiry without sleeping.
	Now func() time.Time
}

func NewTracker() *Tracker {
	return &Tracker{seen: map[string]time.Time{}, Now: time.Now}
}

func (t *Tracker) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

// Touch records that installID was just seen. Empty ids are ignored so requests
// from the desktop or an older mobile build never create phantom entries.
func (t *Tracker) Touch(installID string) {
	if installID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.seen[installID] = t.now()
}

// Live returns the set of install ids seen within the TTL. Expired entries are
// dropped as they are found, so the map cannot grow without bound.
func (t *Tracker) Live() map[string]bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	cutoff := t.now().Add(-TTL)
	live := make(map[string]bool, len(t.seen))
	for id, at := range t.seen {
		if at.Before(cutoff) {
			delete(t.seen, id)
			continue
		}
		live[id] = true
	}
	return live
}
