// Package workerhub routes live terminal commands to the authoritative worker
// connection for one session. Durable state remains in PostgreSQL.
package workerhub

import (
	"errors"
	"sync"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

const commandBufferSize = 256

// Command is a live instruction sent to a connected cloud worker.
type Command struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId,omitempty"`
	Action    string `json:"action,omitempty"`
	Data      string `json:"data,omitempty"`
	Sequence  int64  `json:"sequence,omitempty"`
	Rows      uint16 `json:"rows,omitempty"`
	Cols      uint16 `json:"cols,omitempty"`
}

type connection struct {
	workerID string
	epoch    int64
	commands chan Command
}

// Hub tracks and routes commands to the current worker for each session.
type Hub struct {
	mu          sync.RWMutex
	connections map[clouddomain.SessionID]connection
	pending     map[clouddomain.SessionID][]Command
}

// New creates an empty worker connection hub.
func New() *Hub {
	return &Hub{
		connections: make(map[clouddomain.SessionID]connection),
		pending:     make(map[clouddomain.SessionID][]Command),
	}
}

// Register installs a worker connection and returns its command stream and cleanup function.
func (h *Hub) Register(
	sessionID clouddomain.SessionID,
	workerID string,
	epoch int64,
) (<-chan Command, func()) {
	h.mu.Lock()
	commands := make(chan Command, commandBufferSize)
	previous, exists := h.connections[sessionID]
	if !exists || previous.epoch <= epoch {
		if exists {
			close(previous.commands)
		}
		h.connections[sessionID] = connection{workerID: workerID, epoch: epoch, commands: commands}
		for _, command := range h.pending[sessionID] {
			commands <- command
		}
		delete(h.pending, sessionID)
	} else {
		close(commands)
	}
	h.mu.Unlock()
	return commands, func() {
		h.mu.Lock()
		current, ok := h.connections[sessionID]
		if ok &&
			current.workerID == workerID &&
			current.epoch == epoch &&
			current.commands == commands {
			h.disconnectLocked(sessionID, current, nil)
		}
		h.mu.Unlock()
	}
}

// DisconnectAndRequeue removes the current worker connection after a failed
// socket write and preserves the in-flight command plus buffered commands for
// the replacement worker.
func (h *Hub) DisconnectAndRequeue(
	sessionID clouddomain.SessionID,
	workerID string,
	epoch int64,
	failed Command,
) {
	h.mu.Lock()
	defer h.mu.Unlock()
	current, ok := h.connections[sessionID]
	if !ok || current.workerID != workerID || current.epoch != epoch {
		return
	}
	h.disconnectLocked(sessionID, current, &failed)
}

// Send queues a command for the session's current worker.
func (h *Hub) Send(sessionID clouddomain.SessionID, command Command) error {
	h.mu.Lock()
	connection, ok := h.connections[sessionID]
	if !ok {
		pending := h.pending[sessionID]
		if len(pending) >= commandBufferSize {
			h.mu.Unlock()
			return ErrWorkerBackpressure
		}
		h.pending[sessionID] = append(pending, command)
		h.mu.Unlock()
		return nil
	}
	select {
	case connection.commands <- command:
		h.mu.Unlock()
		return nil
	default:
		h.mu.Unlock()
		return ErrWorkerBackpressure
	}
}

func (h *Hub) disconnectLocked(
	sessionID clouddomain.SessionID,
	current connection,
	failed *Command,
) {
	delete(h.connections, sessionID)
	pending := h.pending[sessionID]
	if failed != nil {
		pending = append(pending, *failed)
	}
	close(current.commands)
	for command := range current.commands {
		pending = append(pending, command)
	}
	h.pending[sessionID] = pending
}

var (
	// ErrWorkerDisconnected indicates that a session has no connected worker.
	ErrWorkerDisconnected = errors.New("cloud worker is disconnected")
	// ErrWorkerBackpressure indicates that the worker command queue is full.
	ErrWorkerBackpressure = errors.New("cloud worker command buffer is full")
)
