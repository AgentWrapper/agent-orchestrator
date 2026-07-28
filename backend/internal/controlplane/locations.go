package controlplane

import (
	"sync"
	"time"
)

// ── Phase B (federated bus) · Turn 1: session-location registry ──────────────
//
// For the orchestrator and its workers to interact when they live in DIFFERENT
// places (local daemon, one sandbox, or N separate sandboxes), the control plane
// must know WHERE each session lives so it can relay send/spawn/kill/events to
// the host that owns it. This file is that directory. Later turns add the
// outbound channel (daemon→CP) and the router that consults this registry.

// LocationType is how the control plane reaches a session's owning agent host.
type LocationType string

const (
	// LocationSandbox: reachable by calling INTO the sandbox via a signed preview
	// URL (the inbound relay that already exists as ProxyFetch).
	LocationSandbox LocationType = "sandbox"
	// LocationDaemon: reachable only by pushing DOWN a live outbound channel the
	// daemon opened to the control plane (added in Turn 2) — e.g. a laptop daemon
	// behind NAT, or an in-sandbox daemon that dialed out.
	LocationDaemon LocationType = "daemon"
)

// SessionLocation records where one agent session lives. Locations are LIVE
// state — valid only while the owning sandbox is running or the owning daemon is
// connected — not durable history. A reconnecting daemon / restored sandbox
// re-registers, so the registry is authoritative for "right now".
type SessionLocation struct {
	SessionID string
	TenantID  string
	ProjectID string
	Kind      string // "orchestrator" | "worker"
	Type      LocationType

	// Set when Type == LocationSandbox.
	SandboxID  string
	PreviewURL string

	// Set when Type == LocationDaemon — the id of the connected daemon that owns
	// this session (maps to a live channel in Turn 2).
	DaemonID string

	UpdatedAt time.Time
}

// LocationRegistry is the control plane's tenant-scoped directory of where every
// session lives. Implementations must be safe for concurrent use.
type LocationRegistry interface {
	// Register records (or overwrites) a session's location.
	Register(loc SessionLocation)
	// Remove drops a single session.
	Remove(tenantID, sessionID string)
	// Lookup returns a session's current location, if known.
	Lookup(tenantID, sessionID string) (SessionLocation, bool)
	// ListForTenant returns every known session location for a tenant.
	ListForTenant(tenantID string) []SessionLocation
	// RemoveDaemon drops every session owned by a daemon (called on disconnect).
	RemoveDaemon(tenantID, daemonID string)
}

// memLocationRegistry is the default in-memory implementation. In-memory is the
// right model: locations are tied to live hosts, so they should evaporate on a
// control-plane restart and be re-established by reconnecting daemons / restored
// sandboxes — not resurrected stale from a database.
type memLocationRegistry struct {
	mu       sync.RWMutex
	byTenant map[string]map[string]SessionLocation // tenantID → sessionID → location
	now      func() time.Time
}

// NewInMemoryLocationRegistry builds an empty registry.
func NewInMemoryLocationRegistry() LocationRegistry {
	return &memLocationRegistry{
		byTenant: make(map[string]map[string]SessionLocation),
		now:      time.Now,
	}
}

func (r *memLocationRegistry) Register(loc SessionLocation) {
	if loc.TenantID == "" || loc.SessionID == "" {
		return
	}
	if loc.UpdatedAt.IsZero() {
		loc.UpdatedAt = r.now()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	sessions := r.byTenant[loc.TenantID]
	if sessions == nil {
		sessions = make(map[string]SessionLocation)
		r.byTenant[loc.TenantID] = sessions
	}
	sessions[loc.SessionID] = loc
}

func (r *memLocationRegistry) Remove(tenantID, sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if sessions := r.byTenant[tenantID]; sessions != nil {
		delete(sessions, sessionID)
		if len(sessions) == 0 {
			delete(r.byTenant, tenantID)
		}
	}
}

func (r *memLocationRegistry) Lookup(tenantID, sessionID string) (SessionLocation, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if sessions := r.byTenant[tenantID]; sessions != nil {
		loc, ok := sessions[sessionID]
		return loc, ok
	}
	return SessionLocation{}, false
}

func (r *memLocationRegistry) ListForTenant(tenantID string) []SessionLocation {
	r.mu.RLock()
	defer r.mu.RUnlock()
	sessions := r.byTenant[tenantID]
	out := make([]SessionLocation, 0, len(sessions))
	for _, loc := range sessions {
		out = append(out, loc)
	}
	return out
}

func (r *memLocationRegistry) RemoveDaemon(tenantID, daemonID string) {
	if daemonID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	sessions := r.byTenant[tenantID]
	if sessions == nil {
		return
	}
	for id, loc := range sessions {
		if loc.Type == LocationDaemon && loc.DaemonID == daemonID {
			delete(sessions, id)
		}
	}
	if len(sessions) == 0 {
		delete(r.byTenant, tenantID)
	}
}
