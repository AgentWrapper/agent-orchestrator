package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// eventBuffer bounds the normalized event stream. Deltas are dropped when a
// consumer falls this far behind; lifecycle events are not.
const eventBuffer = 4096

// approvalWait bounds how long the provider is left blocked on an unanswered
// request. Codex holds its turn until the client replies, so an approval nobody
// resolves would hang the session indefinitely. On expiry AO refuses rather than
// deciding on the user's behalf.
const approvalWait = 30 * time.Minute

// errConversationClosed reports a decision arriving after the controller ended.
var errConversationClosed = errors.New("conversation closed")

// approvalMethods are the server->client requests that represent a decision the
// user must make. Anything else the provider asks is refused: answering a request
// AO does not model risks consenting to something on the user's behalf.
var approvalMethods = map[string]domain.ActivityKind{
	"item/commandExecution/requestApproval": domain.ActivityKindCommand,
	"item/fileChange/requestApproval":       domain.ActivityKindFileChange,
	"item/permissions/requestApproval":      domain.ActivityKindApproval,
	"item/tool/requestUserInput":            domain.ActivityKindApproval,
}

// conversation is one live Codex thread. It is the only writer to that thread.
type conversation struct {
	conn *conn
	proc *process
	log  *slog.Logger

	threadID string
	events   chan ports.ChatEvent

	mu      sync.Mutex
	pending map[string]chan ports.ChatDecision
	closed  bool

	// sendMu serializes turn dispatch so only one operation mutates the provider
	// conversation at a time.
	sendMu sync.Mutex

	// activeTurn is the most recent provider turn id, used when a caller asks to
	// interrupt without naming one.
	activeTurn string

	pumpDone  chan struct{}
	closeOnce sync.Once
}

var _ ports.ChatConversation = (*conversation)(nil)

func newConversation(proc *process, log *slog.Logger) *conversation {
	c := &conversation{
		proc:     proc,
		log:      log,
		events:   make(chan ports.ChatEvent, eventBuffer),
		pending:  make(map[string]chan ports.ChatDecision),
		pumpDone: make(chan struct{}),
	}
	c.conn = newConn(proc.stdin, proc.stdout, log, c.handleServerRequest)
	return c
}

// start records the opened thread and begins translating notifications. It is
// called once, after the thread is open, so no event is emitted for a
// conversation the caller does not yet have a handle to.
func (c *conversation) start(threadID string) {
	c.threadID = threadID
	go c.pump()
}

// ProviderConversationID is the Codex thread id AO persists for resume.
func (c *conversation) ProviderConversationID() string { return c.threadID }

// Capabilities reports what this conversation can do.
func (c *conversation) Capabilities() ports.ChatCapabilities { return capabilities() }

// Events is the normalized stream. It closes when the conversation ends.
func (c *conversation) Events() <-chan ports.ChatEvent { return c.events }

// pump translates provider notifications into neutral events until the
// connection ends, then reports why and closes the stream.
func (c *conversation) pump() {
	defer close(c.pumpDone)
	defer close(c.events)

	for n := range c.conn.notifs() {
		for _, ev := range normalizeNotification(n) {
			if ev.Kind == ports.ChatEventTurnStarted && ev.ProviderTurnID != "" {
				c.mu.Lock()
				c.activeTurn = ev.ProviderTurnID
				c.mu.Unlock()
			}
			if ev.Kind == ports.ChatEventApprovalResolved {
				// The provider resolved it (possibly via another client), so any
				// card AO is still showing is stale.
				c.discardPending(ev.RequestID)
			}
			c.emit(ev)
		}
	}

	// The connection ended. Say so explicitly rather than letting the stream go
	// quiet: a silent channel close is indistinguishable from an idle agent.
	state := ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerStopped}
	if err := c.conn.err(); err != nil {
		state.Err = err
	}
	c.emit(state)
	c.failPendingApprovals()
}

// emit delivers an event, preferring to drop a delta over blocking the reader. A
// lifecycle event is never dropped silently.
func (c *conversation) emit(ev ports.ChatEvent) {
	select {
	case c.events <- ev:
		return
	default:
	}

	if ev.Kind == ports.ChatEventMessageDelta {
		// The settled text arrives on message.completed, so a dropped delta
		// costs smoothness, not correctness.
		c.log.Warn("dropped chat message delta: consumer behind", "item", ev.ProviderItemID)
		return
	}

	select {
	case c.events <- ev:
	case <-time.After(5 * time.Second):
		c.log.Error("dropped chat lifecycle event: consumer stalled", "kind", ev.Kind)
	}
}

// SendTurn delivers one message to the provider.
func (c *conversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if strings.TrimSpace(msg.Text) == "" {
		// There is no keystroke concept here: an empty message is a caller bug,
		// not a way to nudge the agent.
		return ports.ChatTurnRef{}, errors.New("chat message text is empty")
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	params := map[string]any{
		"threadId": c.threadID,
		"input":    []any{map[string]any{"type": "text", "text": msg.Text}},
	}
	if msg.ClientMessageID != "" {
		// The provider's own idempotency handle: a retry carrying the same id
		// must not produce a second turn.
		params["clientUserMessageId"] = msg.ClientMessageID
	}

	var resp struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.conn.request(ctx, "turn/start", params, &resp); err != nil {
		return ports.ChatTurnRef{}, fmt.Errorf("turn/start: %w", err)
	}

	c.mu.Lock()
	c.activeTurn = resp.Turn.ID
	c.mu.Unlock()

	return ports.ChatTurnRef{ProviderTurnID: resp.Turn.ID}, nil
}

// Interrupt cancels a turn. An empty turn id targets the active one.
func (c *conversation) Interrupt(ctx context.Context, providerTurnID string) error {
	if providerTurnID == "" {
		c.mu.Lock()
		providerTurnID = c.activeTurn
		c.mu.Unlock()
	}
	if providerTurnID == "" {
		return errors.New("no active turn to interrupt")
	}
	if err := c.conn.request(ctx, "turn/interrupt", map[string]any{
		"threadId": c.threadID,
		"turnId":   providerTurnID,
	}, nil); err != nil {
		return fmt.Errorf("turn/interrupt: %w", err)
	}
	return nil
}

// ResolveRequest answers a parked approval or user-input request.
func (c *conversation) ResolveRequest(ctx context.Context, requestID string, decision ports.ChatDecision) error {
	c.mu.Lock()
	ch, ok := c.pending[requestID]
	if ok {
		delete(c.pending, requestID)
	}
	closed := c.closed
	c.mu.Unlock()

	if closed {
		return errConversationClosed
	}
	if !ok {
		// Already resolved, superseded, or from a previous controller. Refusing
		// is required: a stale card must never resolve a newer request.
		return fmt.Errorf("no pending request %q", requestID)
	}

	select {
	case ch <- decision:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// handleServerRequest parks a provider request until a decision arrives.
//
// The provider blocks its turn on the reply, so this deliberately waits rather
// than answering immediately. Everything AO does not model is refused with an
// error, never with a fabricated decision.
func (c *conversation) handleServerRequest(ctx context.Context, req serverRequest) (any, error) {
	kind, known := approvalMethods[req.Method]
	if !known {
		c.log.Warn("refusing unmodelled app-server request", "method", req.Method)
		return nil, fmt.Errorf("unsupported request %s", req.Method)
	}

	requestID := rawID(req.ID)
	if requestID == "" {
		return nil, errors.New("server request carried no id")
	}

	decisions, summary, detail := parseApproval(req.Method, req.Params)

	ch := make(chan ports.ChatDecision, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errConversationClosed
	}
	c.pending[requestID] = ch
	c.mu.Unlock()

	c.emit(ports.ChatEvent{
		Kind:           ports.ChatEventApprovalRequested,
		ProviderItemID: requestID,
		RequestID:      requestID,
		ActivityKind:   kind,
		ActivityStatus: domain.ActivityStatusPending,
		Summary:        summary,
		Detail:         detail,
		Decisions:      decisions,
	})

	select {
	case decision := <-ch:
		return approvalReply(req.Method, decision), nil

	case <-time.After(approvalWait):
		c.discardPending(requestID)
		return nil, errors.New("approval timed out without a decision")

	case <-ctx.Done():
		c.discardPending(requestID)
		return nil, ctx.Err()
	}
}

func (c *conversation) discardPending(requestID string) {
	c.mu.Lock()
	delete(c.pending, requestID)
	c.mu.Unlock()
}

// failPendingApprovals unblocks every parked handler when the controller ends.
func (c *conversation) failPendingApprovals() {
	c.mu.Lock()
	pending := c.pending
	c.pending = map[string]chan ports.ChatDecision{}
	c.closed = true
	c.mu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}

// Close releases the controller without touching provider-side history.
func (c *conversation) Close() error {
	c.closeOnce.Do(func() {
		c.failPendingApprovals()
		if c.proc.stop != nil {
			_ = c.proc.stop()
		}
	})
	return nil
}

// approvalPayload is the subset of an approval request AO renders.
type approvalPayload struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Command  string `json:"command"`
	Cwd      string `json:"cwd"`
	Reason   string `json:"reason"`
	// AvailableDecisions is authoritative: the provider varies the offered set
	// per request and does not always offer a plain decline, so a client must
	// render from this rather than a fixed set of buttons.
	AvailableDecisions []json.RawMessage `json:"availableDecisions"`
	Questions          []struct {
		ID      string `json:"id"`
		Prompt  string `json:"prompt"`
		Options []struct {
			Label string `json:"label"`
		} `json:"options"`
	} `json:"questions"`
}

// parseApproval extracts the decisions, label, and neutral detail for a request.
func parseApproval(method string, params json.RawMessage) ([]ports.ChatDecisionOption, string, []byte) {
	var p approvalPayload
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, "Approval required", nil
	}

	options := make([]ports.ChatDecisionOption, 0, len(p.AvailableDecisions))
	for _, raw := range p.AvailableDecisions {
		if opt, ok := decisionOption(raw); ok {
			options = append(options, opt)
		}
	}

	summary := "Approval required"
	switch {
	case p.Command != "":
		summary = "Run " + commandSummary(p.Command)
	case method == "item/fileChange/requestApproval":
		summary = "Apply file changes"
	case method == "item/tool/requestUserInput" && len(p.Questions) > 0:
		summary = p.Questions[0].Prompt
	case p.Reason != "":
		summary = p.Reason
	}

	detail := map[string]any{"method": method}
	if p.Command != "" {
		detail["command"] = unwrapShell(p.Command)
		detail["rawCommand"] = p.Command
	}
	if p.Cwd != "" {
		detail["cwd"] = p.Cwd
	}
	if p.ItemID != "" {
		detail["itemId"] = p.ItemID
	}
	if p.Reason != "" {
		detail["reason"] = p.Reason
	}
	if len(p.Questions) > 0 {
		detail["questions"] = p.Questions
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		encoded = nil
	}
	return options, summary, encoded
}

// decisionOption reads one entry of availableDecisions, which is either a plain
// string ("accept") or a single-key object carrying parameters
// ({"acceptWithExecpolicyAmendment": {...}}).
func decisionOption(raw json.RawMessage) (ports.ChatDecisionOption, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return ports.ChatDecisionOption{}, false
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		if asString == "" {
			return ports.ChatDecisionOption{}, false
		}
		return ports.ChatDecisionOption{ID: asString, Label: decisionLabel(asString), Raw: raw}, true
	}

	var asObject map[string]json.RawMessage
	if err := json.Unmarshal(raw, &asObject); err != nil || len(asObject) != 1 {
		return ports.ChatDecisionOption{}, false
	}
	for key := range asObject {
		return ports.ChatDecisionOption{ID: key, Label: decisionLabel(key), Raw: raw}, true
	}
	return ports.ChatDecisionOption{}, false
}

// decisionLabel gives known decision ids readable text. An unknown id falls back
// to its own name rather than being hidden, so a new provider decision still
// renders as a usable button.
func decisionLabel(id string) string {
	switch id {
	case "accept":
		return "Approve"
	case "acceptForSession":
		return "Approve for this session"
	case "acceptWithExecpolicyAmendment":
		return "Approve and remember this command"
	case "decline":
		return "Decline"
	case "cancel":
		return "Cancel"
	default:
		return id
	}
}

// approvalReply builds the provider response for a decision. A decision carrying
// Raw is echoed verbatim so the structured forms round-trip exactly.
func approvalReply(method string, decision ports.ChatDecision) any {
	if method == "item/tool/requestUserInput" {
		// User-input replies are answers, not decisions; the raw payload is the
		// whole response body.
		if len(decision.Raw) > 0 {
			return json.RawMessage(decision.Raw)
		}
		return map[string]any{"answers": map[string]any{}}
	}
	if len(decision.Raw) > 0 {
		return map[string]any{"decision": json.RawMessage(decision.Raw)}
	}
	return map[string]any{"decision": decision.ID}
}
