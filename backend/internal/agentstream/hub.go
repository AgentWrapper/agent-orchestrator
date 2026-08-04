package agentstream

import (
	"sync"
)

const (
	// DefaultReplayCapacity is how many recent events are kept per session for
	// SSE reconnect (after=sequence).
	DefaultReplayCapacity = 512
	// DefaultSubscriberBuffer is the per-subscriber live channel size. When
	// full, the hub drops the slowest subscriber rather than blocking producers.
	DefaultSubscriberBuffer = 256
)

// Hub fans normalized stream events out to SSE subscribers and keeps a short
// per-session replay ring for reconnect.
//
// Producers (ACP drivers, tests) call PublishBridge or Publish. Consumers
// Subscribe with an optional after sequence.
type Hub struct {
	mu       sync.RWMutex
	norm     *Normalizer
	sessions map[string]*hubSession
	capacity int
	subBuf   int
}

type hubSession struct {
	// ring holds the most recent events in sequence order (oldest first).
	ring []Event
	// subs maps subscriber id → channel
	subs map[uint64]chan Event
	next uint64
}

// NewHub constructs a stream hub with a dedicated normalizer.
func NewHub() *Hub {
	return &Hub{
		norm:     NewNormalizer(),
		sessions: make(map[string]*hubSession),
		capacity: DefaultReplayCapacity,
		subBuf:   DefaultSubscriberBuffer,
	}
}

// Normalizer returns the hub's shared normalizer (for advanced producers).
func (h *Hub) Normalizer() *Normalizer { return h.norm }

// ConfigureSession sets the stream source advertised on subsequent events.
func (h *Hub) ConfigureSession(sessionID string, source Source) {
	h.norm.ConfigureSession(sessionID, source)
}

// ClearSession drops normalizer state, replay, and subscribers for a session.
func (h *Hub) ClearSession(sessionID string) {
	h.norm.ClearSession(sessionID)
	h.mu.Lock()
	defer h.mu.Unlock()
	if s, ok := h.sessions[sessionID]; ok {
		for id, ch := range s.subs {
			close(ch)
			delete(s.subs, id)
		}
		delete(h.sessions, sessionID)
	}
}

// PublishBridge normalizes a bridge event and fans it out. Returns the
// sequenced event, or nil when the normalizer drops the input.
func (h *Hub) PublishBridge(sessionID string, event BridgeEvent) *Event {
	out := h.norm.Normalize(sessionID, event)
	if out == nil {
		return nil
	}
	h.publish(*out)
	return out
}

// Publish fans out an already-sequenced event (tests / advanced producers).
// Prefer PublishBridge so sequence ownership stays in the normalizer.
func (h *Hub) Publish(event Event) {
	h.publish(event)
}

// PublishACPSessionUpdate maps an ACP session/update and publishes it.
// Returns the sequenced event when one was emitted.
func (h *Hub) PublishACPSessionUpdate(sessionID string, update ACPSessionUpdate) *Event {
	be, ok := MapACPSessionUpdate(update)
	if !ok {
		return nil
	}
	return h.PublishBridge(sessionID, be)
}

// Subscribe returns a live channel of events with sequence > after, plus a
// snapshot of buffered events already past after. Call unsubscribe when done.
func (h *Hub) Subscribe(sessionID string, after int64) (replay []Event, live <-chan Event, unsubscribe func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s := h.ensureSessionLocked(sessionID)
	replay = filterAfter(s.ring, after)

	id := s.next
	s.next++
	ch := make(chan Event, h.subBuf)
	s.subs[id] = ch

	unsub := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		ss, ok := h.sessions[sessionID]
		if !ok {
			return
		}
		if c, ok := ss.subs[id]; ok {
			delete(ss.subs, id)
			close(c)
		}
	}
	return replay, ch, unsub
}

// Replay returns buffered events with sequence > after without subscribing.
func (h *Hub) Replay(sessionID string, after int64) []Event {
	h.mu.RLock()
	defer h.mu.RUnlock()
	s, ok := h.sessions[sessionID]
	if !ok {
		return nil
	}
	return filterAfter(s.ring, after)
}

func (h *Hub) publish(event Event) {
	h.mu.Lock()
	defer h.mu.Unlock()

	s := h.ensureSessionLocked(event.SessionID)
	s.ring = append(s.ring, event)
	if len(s.ring) > h.capacity {
		// Drop oldest.
		s.ring = append([]Event(nil), s.ring[len(s.ring)-h.capacity:]...)
	}
	for id, ch := range s.subs {
		select {
		case ch <- event:
		default:
			// Slow subscriber: drop it rather than block the producer path.
			close(ch)
			delete(s.subs, id)
		}
	}
}

func (h *Hub) ensureSessionLocked(sessionID string) *hubSession {
	s, ok := h.sessions[sessionID]
	if !ok {
		s = &hubSession{subs: make(map[uint64]chan Event)}
		h.sessions[sessionID] = s
	}
	return s
}

func filterAfter(ring []Event, after int64) []Event {
	if len(ring) == 0 {
		return nil
	}
	out := make([]Event, 0, len(ring))
	for _, e := range ring {
		if e.Sequence > after {
			out = append(out, e)
		}
	}
	return out
}
