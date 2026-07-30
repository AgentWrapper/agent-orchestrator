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
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
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
		if ok && current.workerID == workerID && current.epoch == epoch {
			delete(h.connections, sessionID)
			close(current.commands)
		}
		h.mu.Unlock()
	}
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

var (
	// ErrWorkerDisconnected indicates that a session has no connected worker.
	ErrWorkerDisconnected = errors.New("cloud worker is disconnected")
	// ErrWorkerBackpressure indicates that the worker command queue is full.
	ErrWorkerBackpressure = errors.New("cloud worker command buffer is full")
)
