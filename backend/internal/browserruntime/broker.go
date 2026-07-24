// Package browserruntime brokers browser commands between the loopback daemon
// and the Electron process that owns AO's per-session WebContentsView targets.
package browserruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProtocolVersion identifies the daemon-to-Electron browser bridge contract.
const ProtocolVersion = 1

// ErrUnavailable indicates that no Electron browser runtime can accept a command.
var ErrUnavailable = errors.New("browser runtime is unavailable")

// Status describes whether Electron is connected to the browser command broker.
type Status struct {
	Connected   bool
	ConnectedAt time.Time
}

// Command is one session-scoped operation sent to the Electron browser runtime.
type Command struct {
	RequestID string                 `json:"requestId"`
	SessionID domain.SessionID       `json:"sessionId"`
	Action    string                 `json:"action"`
	Args      map[string]interface{} `json:"args,omitempty"`
}

// CommandError is a stable browser failure returned by the Electron runtime.
type CommandError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e CommandError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return fmt.Sprintf("%s (%s)", e.Message, e.Code)
}

// Result contains the correlated response to a browser command.
type Result struct {
	RequestID string
	Value     interface{}
}

type wireMessage struct {
	Type      string                 `json:"type"`
	Version   int                    `json:"version,omitempty"`
	RequestID string                 `json:"requestId,omitempty"`
	SessionID domain.SessionID       `json:"sessionId,omitempty"`
	Action    string                 `json:"action,omitempty"`
	Args      map[string]interface{} `json:"args,omitempty"`
	OK        bool                   `json:"ok,omitempty"`
	Result    json.RawMessage        `json:"result,omitempty"`
	Error     *CommandError          `json:"error,omitempty"`
}

type pendingResult struct {
	value interface{}
	err   error
}

// Broker owns the single active Electron runtime connection. Commands are
// correlated by request id, so independent AO sessions may use the bridge
// concurrently without sharing browser targets or results.
type Broker struct {
	log *slog.Logger

	mu          sync.Mutex
	conn        net.Conn
	connectedAt time.Time
	pending     map[string]chan pendingResult
	writeMu     sync.Mutex
}

// New creates an empty browser command broker.
func New(log *slog.Logger) *Broker {
	if log == nil {
		log = slog.Default()
	}
	return &Broker{log: log, pending: make(map[string]chan pendingResult)}
}

// Status returns the current Electron runtime connection state.
func (b *Broker) Status() Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return Status{Connected: b.conn != nil, ConnectedAt: b.connectedAt}
}

// Execute sends one browser command to the connected Electron runtime.
func (b *Broker) Execute(ctx context.Context, sessionID domain.SessionID, action string, args map[string]interface{}) (Result, error) {
	requestID := uuid.NewString()
	resultCh := make(chan pendingResult, 1)

	b.mu.Lock()
	conn := b.conn
	if conn == nil {
		b.mu.Unlock()
		return Result{}, ErrUnavailable
	}
	b.pending[requestID] = resultCh
	b.mu.Unlock()

	msg := wireMessage{
		Type:      "command",
		RequestID: requestID,
		SessionID: sessionID,
		Action:    action,
		Args:      args,
	}
	if err := b.write(conn, msg); err != nil {
		b.removePending(requestID)
		b.disconnect(conn, fmt.Errorf("write browser command: %w", err))
		return Result{}, ErrUnavailable
	}

	select {
	case <-ctx.Done():
		b.removePending(requestID)
		return Result{}, ctx.Err()
	case result := <-resultCh:
		if result.err != nil {
			return Result{}, result.err
		}
		return Result{RequestID: requestID, Value: result.value}, nil
	}
}

// Serve accepts Electron runtime connections until ctx is cancelled. A new
// valid runtime replaces an older connection and fails its in-flight commands;
// this makes renderer reload/restart recovery deterministic.
func (b *Broker) Serve(ctx context.Context, ln net.Listener) error {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil //nolint:nilerr // listener closure is the expected shutdown path
			}
			return fmt.Errorf("accept browser runtime: %w", err)
		}
		go b.serveConn(ctx, conn)
	}
}

func (b *Broker) serveConn(ctx context.Context, conn net.Conn) {
	dec := json.NewDecoder(conn)
	var hello wireMessage
	if err := dec.Decode(&hello); err != nil || hello.Type != "hello" || hello.Version != ProtocolVersion {
		_ = conn.Close()
		return
	}

	b.mu.Lock()
	old := b.conn
	b.conn = conn
	b.connectedAt = time.Now().UTC()
	pending := b.takePendingLocked()
	b.mu.Unlock()
	if old != nil && old != conn {
		_ = old.Close()
	}
	failPending(pending, ErrUnavailable)
	b.log.Info("browser runtime connected")

	go func() {
		<-ctx.Done()
		_ = conn.Close()
	}()

	for {
		var msg wireMessage
		if err := dec.Decode(&msg); err != nil {
			b.disconnect(conn, err)
			return
		}
		if msg.Type != "result" || msg.RequestID == "" {
			continue
		}
		b.resolve(msg)
	}
}

func (b *Broker) write(conn net.Conn, msg wireMessage) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	return json.NewEncoder(conn).Encode(msg)
}

func (b *Broker) resolve(msg wireMessage) {
	b.mu.Lock()
	ch := b.pending[msg.RequestID]
	delete(b.pending, msg.RequestID)
	b.mu.Unlock()
	if ch == nil {
		return
	}
	if !msg.OK {
		if msg.Error == nil {
			msg.Error = &CommandError{Code: "BROWSER_COMMAND_FAILED", Message: "Browser command failed"}
		}
		ch <- pendingResult{err: *msg.Error}
		return
	}
	var value interface{} = map[string]interface{}{}
	if len(msg.Result) > 0 && string(msg.Result) != "null" {
		if err := json.Unmarshal(msg.Result, &value); err != nil {
			ch <- pendingResult{err: fmt.Errorf("decode browser result: %w", err)}
			return
		}
	}
	ch <- pendingResult{value: value}
}

func (b *Broker) disconnect(conn net.Conn, cause error) {
	b.mu.Lock()
	if b.conn != conn {
		b.mu.Unlock()
		return
	}
	b.conn = nil
	b.connectedAt = time.Time{}
	pending := b.takePendingLocked()
	b.mu.Unlock()
	_ = conn.Close()
	failPending(pending, ErrUnavailable)
	if cause != nil && !errors.Is(cause, io.EOF) && !errors.Is(cause, net.ErrClosed) {
		b.log.Warn("browser runtime disconnected", "err", cause)
	} else {
		b.log.Info("browser runtime disconnected")
	}
}

func (b *Broker) removePending(requestID string) {
	b.mu.Lock()
	delete(b.pending, requestID)
	b.mu.Unlock()
}

func (b *Broker) takePendingLocked() map[string]chan pendingResult {
	pending := b.pending
	b.pending = make(map[string]chan pendingResult)
	return pending
}

func failPending(pending map[string]chan pendingResult, err error) {
	for _, ch := range pending {
		ch <- pendingResult{err: err}
	}
}
