package controlplane

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/busproto"
)

// ── Phase B (federated bus) · Turns 2–4: the router ──────────────────────────
//
// The Hub is the control plane's message router across locations. Every daemon
// (a laptop's local daemon, or an in-sandbox agent-host) keeps a live push
// channel to the hub and registers its sessions. When a command targets a
// session the caller can't reach locally, it goes to the hub, which looks the
// session up in the LocationRegistry and relays it to the owning host:
//
//	ao send worker-X ─▶ orchestrator's daemon ─"not mine"▶ hub
//	                                                        ├─ worker-X in a sandbox → relay via preview URL
//	                                                        └─ worker-X on a daemon  → push down that daemon's channel
//
// Events (worker → orchestrator) flow back the same way. The hub is
// transport-agnostic: it speaks to daemons through the daemonConn interface, so
// the SSE/HTTP transport (bus_transport.go) is one implementation and tests use
// a fake.

var (
	// ErrSessionNotFound: the target session isn't in the registry (unknown, or
	// its host disconnected).
	ErrSessionNotFound = errors.New("bus: session not found")
	// ErrDaemonOffline: the session lives on a daemon that has no live channel.
	ErrDaemonOffline = errors.New("bus: owning daemon is offline")
)

// The wire types live in busproto (shared with the daemon-side bus client).
// These aliases keep the controlplane call sites terse and unchanged.
type (
	FrameType  = busproto.FrameType
	SessionRef = busproto.SessionRef
	Command    = busproto.Command
	Event      = busproto.Event
	Frame      = busproto.Frame
)

const (
	FrameRegister = busproto.FrameRegister
	FrameCommand  = busproto.FrameCommand
	FrameEvent    = busproto.FrameEvent
	FrameAck      = busproto.FrameAck
)

// daemonConn is a live push channel to one connected daemon. The transport
// (SSE) implements it; tests use a fake.
type daemonConn interface {
	send(Frame) error
}

// SandboxRelay reaches a session that lives inside a sandbox, using the inbound
// path that already exists (a signed preview URL → the sandbox's daemon API).
type SandboxRelay interface {
	Relay(ctx context.Context, previewURL string, cmd Command) error
	RelayEvent(ctx context.Context, previewURL string, ev Event) error
}

// Hub routes commands/events to whichever host owns the target session.
type Hub struct {
	mu        sync.RWMutex
	conns     map[string]map[string]daemonConn // tenantID → daemonID → conn
	locations LocationRegistry
	relay     SandboxRelay
	log       *slog.Logger
}

// NewHub builds a router over a location registry and a sandbox relay.
func NewHub(locations LocationRegistry, relay SandboxRelay, log *slog.Logger) *Hub {
	if log == nil {
		log = slog.Default()
	}
	return &Hub{
		conns:     make(map[string]map[string]daemonConn),
		locations: locations,
		relay:     relay,
		log:       log,
	}
}

// Connect registers a daemon's live push channel.
func (h *Hub) Connect(tenantID, daemonID string, c daemonConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	byDaemon := h.conns[tenantID]
	if byDaemon == nil {
		byDaemon = make(map[string]daemonConn)
		h.conns[tenantID] = byDaemon
	}
	byDaemon[daemonID] = c
}

// Disconnect drops a daemon's channel and forgets every session it owned — but
// only if the still-registered channel is the exact conn that is departing.
// Otherwise a slow teardown of an OLD stream would clobber a NEWLY reconnected
// daemon's live channel and wipe its freshly re-registered sessions. (Audit
// findings #6/#11: compare-and-delete.)
func (h *Hub) Disconnect(tenantID, daemonID string, c daemonConn) {
	h.mu.Lock()
	byDaemon := h.conns[tenantID]
	if byDaemon == nil || byDaemon[daemonID] != c {
		h.mu.Unlock()
		return // a newer connection replaced us; leave it (and its sessions) alone
	}
	delete(byDaemon, daemonID)
	if len(byDaemon) == 0 {
		delete(h.conns, tenantID)
	}
	h.mu.Unlock()
	h.locations.RemoveDaemon(tenantID, daemonID)
}

// Register records the sessions a daemon owns into the location registry, so
// commands/events targeting them route to this daemon.
func (h *Hub) Register(tenantID, daemonID string, sessions []SessionRef) {
	for _, s := range sessions {
		h.locations.Register(SessionLocation{
			SessionID: s.SessionID,
			TenantID:  tenantID,
			ProjectID: s.ProjectID,
			Kind:      s.Kind,
			Type:      LocationDaemon,
			DaemonID:  daemonID,
		})
	}
}

// AuthorizeBusTarget decides whether a SCOPED bus-token caller (scoped to sandbox
// `scope`) may address `targetID`. A full user token (scoped=false, checked by
// the caller) bypasses this. A scoped caller may reach only: itself, the
// orchestrator that owns it, or a worker it owns. This confines a per-sandbox
// token so it can't drive or message unrelated sessions in a shared org tenant
// (audit #5). Unknown target ⇒ allowed here (routing returns ErrSessionNotFound).
func (h *Hub) AuthorizeBusTarget(tenantID, scope, targetID string) bool {
	if scope == "" || scope == targetID {
		return true // unscoped, or addressing self
	}
	target, ok := h.locations.Lookup(tenantID, targetID)
	if !ok {
		return true // not found → let routing surface ErrSessionNotFound
	}
	if target.OrchestratorID == scope {
		return true // caller orchestrates the target
	}
	if caller, ok := h.locations.Lookup(tenantID, scope); ok && caller.OrchestratorID == targetID {
		return true // target is the caller's orchestrator
	}
	return false
}

// conn returns the live channel for a daemon, if any.
func (h *Hub) conn(tenantID, daemonID string) (daemonConn, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if byDaemon := h.conns[tenantID]; byDaemon != nil {
		c, ok := byDaemon[daemonID]
		return c, ok
	}
	return nil, false
}

// RouteCommand delivers a command to whichever host owns cmd.SessionID.
func (h *Hub) RouteCommand(ctx context.Context, tenantID string, cmd Command) error {
	loc, ok := h.locations.Lookup(tenantID, cmd.SessionID)
	if !ok {
		return ErrSessionNotFound
	}
	switch loc.Type {
	case LocationSandbox:
		// cmd.SessionID is the routing key (sandboxId); rewrite it to the
		// in-sandbox session id the sandbox daemon actually knows before relaying.
		relayCmd := cmd
		relayCmd.SessionID = loc.InSandboxSessionID
		return h.relay.Relay(ctx, loc.PreviewURL, relayCmd)
	case LocationDaemon:
		c, ok := h.conn(tenantID, loc.DaemonID)
		if !ok {
			return ErrDaemonOffline
		}
		return c.send(Frame{Type: FrameCommand, Command: &cmd})
	default:
		return ErrSessionNotFound
	}
}

// DeliverEvent routes an event to whichever host owns ev.ToSessionID.
func (h *Hub) DeliverEvent(ctx context.Context, tenantID string, ev Event) error {
	loc, ok := h.locations.Lookup(tenantID, ev.ToSessionID)
	if !ok {
		return ErrSessionNotFound
	}
	switch loc.Type {
	case LocationSandbox:
		// ev.ToSessionID is the routing key (sandboxId); rewrite to the in-sandbox
		// session id for the relay into the sandbox.
		relayEv := ev
		relayEv.ToSessionID = loc.InSandboxSessionID
		return h.relay.RelayEvent(ctx, loc.PreviewURL, relayEv)
	case LocationDaemon:
		c, ok := h.conn(tenantID, loc.DaemonID)
		if !ok {
			return ErrDaemonOffline
		}
		return c.send(Frame{Type: FrameEvent, Event: &ev})
	default:
		return ErrSessionNotFound
	}
}
