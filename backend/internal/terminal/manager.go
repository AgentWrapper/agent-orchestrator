package terminal

import (
	"context"
	"encoding/base64"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// EventSource is the session-state feed the "sessions" channel forwards. The CDC
// broadcaster satisfies it; the interface lives next to its consumer so terminal
// does not depend on CDC internals beyond the Event shape.
type EventSource interface {
	Subscribe(fn func(cdc.Event)) (unsubscribe func())
}

// wsConn is the transport seam: a JSON-framed, single-reader/single-writer
// WebSocket connection. internal/httpd adapts coder/websocket to this; tests
// supply an in-memory fake. WriteJSON is only ever called from the per-conn
// writer goroutine; Ping may be called concurrently (it is a control frame).
type wsConn interface {
	ReadJSON(ctx context.Context, v any) error
	WriteJSON(ctx context.Context, v any) error
	Ping(ctx context.Context) error
	Close(reason string) error
}

const (
	defaultHeartbeat   = 15 * time.Second
	defaultWriteBuffer = 1024
)

// Manager owns the set of live terminal sessions and serves WebSocket clients.
// Sessions outlive any single connection: multiple clients can attach to the
// same pane, and a client reconnect re-subscribes to the existing session.
type Manager struct {
	src       PTYSource
	events    EventSource
	spawn     spawnFunc
	log       *slog.Logger
	heartbeat time.Duration

	// ctx scopes every session's PTY lifetime; cancelled by Close.
	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	sessions map[string]*session
	closed   bool
}

// Option configures a Manager.
type Option func(*Manager)

// WithSpawn overrides the PTY spawner (tests inject a fake).
func WithSpawn(fn spawnFunc) Option { return func(m *Manager) { m.spawn = fn } }

// WithHeartbeat overrides the ping interval.
func WithHeartbeat(d time.Duration) Option { return func(m *Manager) { m.heartbeat = d } }

// NewManager builds a Manager. src attaches PTYs; events feeds the session
// channel (may be nil to disable it); log is required.
func NewManager(src PTYSource, events EventSource, log *slog.Logger, opts ...Option) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{
		src:       src,
		events:    events,
		spawn:     defaultSpawn,
		log:       log,
		heartbeat: defaultHeartbeat,
		ctx:       ctx,
		cancel:    cancel,
		sessions:  map[string]*session{},
	}
	for _, opt := range opts {
		opt(m)
	}
	return m
}

// Close tears down every session and stops re-attach loops. Safe to call once on
// daemon shutdown.
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	sessions := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = map[string]*session{}
	m.mu.Unlock()

	m.cancel()
	for _, s := range sessions {
		s.close()
	}
}

// openSession returns the live session for id, starting it on first open. The id
// is the runtime handle id (tmux target).
func (m *Manager) openSession(id string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, context.Canceled
	}
	if s, ok := m.sessions[id]; ok {
		return s, nil
	}
	handle := ports.RuntimeHandle{ID: id}
	s := newSession(id, handle, m.src, m.spawn, m.log)
	m.sessions[id] = s
	go func() {
		s.run(m.ctx)
		m.mu.Lock()
		if cur, ok := m.sessions[id]; ok && cur == s {
			delete(m.sessions, id)
		}
		m.mu.Unlock()
	}()
	return s, nil
}

// Serve runs the protocol loop for one client connection until it errors, the
// client disconnects, or ctx/the manager is cancelled. It owns the single writer
// goroutine and the heartbeat.
func (m *Manager) Serve(ctx context.Context, conn wsConn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	c := &connState{
		mgr:    m,
		conn:   conn,
		cancel: cancel,
		out:    make(chan serverMsg, defaultWriteBuffer),
		terms:  map[string]func(){},
	}
	defer c.cleanup()

	go c.writeLoop(ctx)
	go c.heartbeatLoop(ctx, m.heartbeat)

	for {
		var msg clientMsg
		if err := conn.ReadJSON(ctx, &msg); err != nil {
			return
		}
		if ctx.Err() != nil {
			return
		}
		c.handle(ctx, msg)
	}
}

// connState is the per-connection mutable state.
type connState struct {
	mgr    *Manager
	conn   wsConn
	cancel context.CancelFunc
	out    chan serverMsg

	mu        sync.Mutex
	terms     map[string]func() // terminal id -> unsubscribe
	unsubEvts func()
	closed    bool
}

func (c *connState) handle(ctx context.Context, msg clientMsg) {
	switch msg.Ch {
	case chTerminal:
		c.handleTerminal(ctx, msg)
	case chSubscribe:
		c.handleSubscribe()
	case chSystem:
		if msg.Type == msgPing {
			c.enqueue(serverMsg{Ch: chSystem, Type: msgPong})
		}
	}
}

func (c *connState) handleTerminal(ctx context.Context, msg clientMsg) {
	switch msg.Type {
	case msgOpen:
		c.openTerminal(ctx, msg.ID)
	case msgData:
		raw, err := base64.StdEncoding.DecodeString(msg.Data)
		if err != nil {
			return
		}
		if s := c.lookup(msg.ID); s != nil {
			_ = s.write(raw)
		}
	case msgResize:
		if s := c.lookup(msg.ID); s != nil {
			_ = s.resize(msg.Rows, msg.Cols)
		}
	case msgClose:
		c.closeTerminal(msg.ID)
	}
}

func (c *connState) openTerminal(_ context.Context, id string) {
	if id == "" {
		c.enqueue(serverMsg{Ch: chTerminal, Type: msgError, Error: "missing terminal id"})
		return
	}
	c.mu.Lock()
	if _, ok := c.terms[id]; ok {
		c.mu.Unlock()
		return // already open on this conn; avoid duplicate replay
	}
	c.mu.Unlock()

	s, err := c.mgr.openSession(id)
	if err != nil {
		c.enqueue(serverMsg{Ch: chTerminal, ID: id, Type: msgError, Error: err.Error()})
		return
	}

	// Ack before subscribing so opened always precedes the replay and any
	// data/exited frames subscribe delivers (the single out channel preserves
	// this order). Reversing it would let a reconnecting client with buffered
	// content, or one opening an already-dead pane, see data/exited before the
	// open acknowledgement.
	c.enqueue(serverMsg{Ch: chTerminal, ID: id, Type: msgOpened})

	unsub, exited := s.subscribe(
		func(data []byte) {
			c.enqueue(serverMsg{
				Ch:   chTerminal,
				ID:   id,
				Type: msgData,
				Data: base64.StdEncoding.EncodeToString(data),
			})
		},
		func() {
			// Clear the connection's entry for this id before sending exited so
			// a client that reopens the moment it sees exited finds no stale
			// entry and is served instead of dropped by the open guard. Ordering
			// the delete after the frame would race that reopen. markExited fires
			// this without s.mu held, so taking c.mu is safe.
			c.mu.Lock()
			delete(c.terms, id)
			c.mu.Unlock()
			c.enqueue(serverMsg{Ch: chTerminal, ID: id, Type: msgExited})
		},
	)
	// An already-exited session sent its exited frame from subscribe and has
	// nothing to unsubscribe. Don't register it: leaving c.terms[id] set would
	// trip the open guard above and silently drop every later open for this id
	// on this connection (e.g. after the pane respawns) until close/reconnect.
	if exited {
		return
	}
	c.mu.Lock()
	c.terms[id] = unsub
	c.mu.Unlock()
}

func (c *connState) closeTerminal(id string) {
	c.mu.Lock()
	unsub := c.terms[id]
	delete(c.terms, id)
	c.mu.Unlock()
	if unsub != nil {
		unsub()
	}
}

func (c *connState) lookup(id string) *session {
	c.mu.Lock()
	_, open := c.terms[id]
	c.mu.Unlock()
	if !open {
		return nil
	}
	c.mgr.mu.Lock()
	s := c.mgr.sessions[id]
	c.mgr.mu.Unlock()
	return s
}

func (c *connState) handleSubscribe() {
	if c.mgr.events == nil {
		return
	}
	c.mu.Lock()
	if c.unsubEvts != nil {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()

	unsub := c.mgr.events.Subscribe(func(e cdc.Event) {
		c.enqueue(serverMsg{
			Ch:   chSessions,
			Type: msgSnapshot,
			Session: &sessionUpdate{
				Seq:       e.Seq,
				ProjectID: e.ProjectID,
				SessionID: e.SessionID,
				EventType: string(e.Type),
			},
		})
	})
	c.mu.Lock()
	c.unsubEvts = unsub
	c.mu.Unlock()
}

// enqueue pushes a frame to the writer. If the buffer is full the client is too
// slow to keep up; tear the connection down rather than stall fan-out for other
// subscribers of the same pane.
func (c *connState) enqueue(msg serverMsg) {
	select {
	case c.out <- msg:
	default:
		c.cancel()
	}
}

func (c *connState) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-c.out:
			if err := c.conn.WriteJSON(ctx, msg); err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *connState) heartbeatLoop(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, interval)
			err := c.conn.Ping(pctx)
			cancel()
			if err != nil {
				c.cancel()
				return
			}
		}
	}
}

func (c *connState) cleanup() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	unsubs := make([]func(), 0, len(c.terms)+1)
	for _, u := range c.terms {
		unsubs = append(unsubs, u)
	}
	c.terms = map[string]func(){}
	if c.unsubEvts != nil {
		unsubs = append(unsubs, c.unsubEvts)
		c.unsubEvts = nil
	}
	c.mu.Unlock()

	for _, u := range unsubs {
		u()
	}
	_ = c.conn.Close("server: connection closed")
}
