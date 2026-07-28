// Package busproto is the wire protocol for the federated bus (Phase B): the
// small, dependency-free set of frame/command/event types shared by the control
// plane's router (internal/controlplane) and the daemon-side bus client
// (internal/busclient). Keeping it standalone means the daemon binary doesn't
// pull the whole server package (Clerk/JWT/pgstore) just to speak the protocol.
package busproto

import "encoding/json"

// FrameType tags a message on the daemon channel.
type FrameType string

const (
	FrameRegister FrameType = "register" // daemon → hub: "here are my sessions"
	FrameCommand  FrameType = "command"  // hub → daemon: run this against a session
	FrameEvent    FrameType = "event"    // daemon → hub: a session emitted something
	FrameAck      FrameType = "ack"      // either way: result of a command
)

// SessionRef is a session a daemon owns, announced in a register frame.
type SessionRef struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"` // "orchestrator" | "worker"
	ProjectID string `json:"projectId,omitempty"`
}

// Command is a control action targeting one session (spawn/send/kill), routed to
// wherever that session lives.
type Command struct {
	Op        string          `json:"op"`        // "send" | "spawn" | "kill"
	SessionID string          `json:"sessionId"` // target session
	Message   string          `json:"message,omitempty"`
	Spec      json.RawMessage `json:"spec,omitempty"` // spawn payload
}

// Event is something a session emitted for another session (e.g. a worker
// reporting to the orchestrator).
type Event struct {
	FromSessionID string          `json:"fromSessionId"`
	ToSessionID   string          `json:"toSessionId"` // routing target
	Kind          string          `json:"kind"`        // "message" | "status" | …
	Data          json.RawMessage `json:"data,omitempty"`
}

// Frame is the unit that flows over a daemon channel.
type Frame struct {
	Type    FrameType `json:"type"`
	ID      string    `json:"id,omitempty"` // correlation id for command/ack
	Command *Command  `json:"command,omitempty"`
	Event   *Event    `json:"event,omitempty"`
	Error   string    `json:"error,omitempty"`
}
