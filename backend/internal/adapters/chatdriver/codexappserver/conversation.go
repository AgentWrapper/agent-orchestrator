package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
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
	pending map[string]*parkedRequest
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

// Asserted here so a refactor cannot silently drop model listing: the service
// feature-detects this interface, and a missed method would just mean "no models"
// with nothing to notice.
var _ ports.ChatModelLister = (*conversation)(nil)

func newConversation(proc *process, log *slog.Logger) *conversation {
	c := &conversation{
		proc:     proc,
		log:      log,
		events:   make(chan ports.ChatEvent, eventBuffer),
		pending:  make(map[string]*parkedRequest),
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
	applyTurnSettings(params, msg.Settings)

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

// applyTurnSettings folds the caller's per-turn choices into a turn/start payload.
//
// Only fields the caller actually chose are sent. An omitted field lets the
// provider fall back to what the thread was started with, which is why a caller
// that chooses nothing behaves exactly as it did before per-turn settings existed.
func applyTurnSettings(params map[string]any, settings ports.ChatTurnSettings) {
	if settings.Model != "" {
		params["model"] = settings.Model
	}
	if settings.Effort != "" {
		params["effort"] = settings.Effort
	}
	if settings.Approval != "" {
		// The same posture thread/start applies, so a per-turn choice and a launch
		// choice cannot mean different things. The wire shapes differ though: a
		// thread takes `sandbox: "workspace-write"`, a turn takes a tagged
		// `sandboxPolicy: {type: "workspaceWrite"}`. Sending a thread's shape to a
		// turn is rejected as a missing `type`, so the two are mapped separately
		// rather than assumed to be interchangeable.
		policy, sandbox := approvalSettings(settings.Approval)
		params["approvalPolicy"] = policy
		params["sandboxPolicy"] = turnSandboxPolicy(sandbox)
	}
}

// turnSandboxPolicy converts a thread-level sandbox name into the tagged object
// turn/start expects.
func turnSandboxPolicy(sandbox string) map[string]any {
	switch sandbox {
	case "workspace-write":
		return map[string]any{"type": "workspaceWrite"}
	case "read-only":
		return map[string]any{"type": "readOnly"}
	default:
		return map[string]any{"type": "dangerFullAccess"}
	}
}

// ListModels asks the provider which models this account may use.
//
// The provider is the only honest source: models get added, renamed, hidden per
// account, and gated by entitlement that AO cannot see. A table in AO would be
// wrong within a week.
func (c *conversation) ListModels(ctx context.Context) ([]ports.ChatModel, error) {
	var resp struct {
		Data []struct {
			ID          string `json:"id"`
			Model       string `json:"model"`
			DisplayName string `json:"displayName"`
			Description string `json:"description"`
			IsDefault   bool   `json:"isDefault"`
			Hidden      bool   `json:"hidden"`
			DefaultEff  string `json:"defaultReasoningEffort"`
			Efforts     []struct {
				ReasoningEffort string `json:"reasoningEffort"`
			} `json:"supportedReasoningEfforts"`
		} `json:"data"`
	}
	if err := c.conn.request(ctx, "model/list", map[string]any{}, &resp); err != nil {
		return nil, fmt.Errorf("model/list: %w", err)
	}

	models := make([]ports.ChatModel, 0, len(resp.Data))
	for _, entry := range resp.Data {
		if entry.Hidden {
			// The provider marks a model hidden when the account should not be
			// offered it. Showing it anyway would offer a choice that then fails.
			continue
		}
		id := entry.ID
		if id == "" {
			id = entry.Model
		}
		if id == "" {
			continue
		}
		efforts := make([]string, 0, len(entry.Efforts))
		for _, effort := range entry.Efforts {
			if effort.ReasoningEffort != "" {
				efforts = append(efforts, effort.ReasoningEffort)
			}
		}
		display := entry.DisplayName
		if display == "" {
			display = id
		}
		models = append(models, ports.ChatModel{
			ID:            id,
			DisplayName:   display,
			Description:   entry.Description,
			Default:       entry.IsDefault,
			Efforts:       efforts,
			DefaultEffort: entry.DefaultEff,
		})
	}
	return models, nil
}

// Interrupt cancels a turn. An empty turn id targets the active one.
func (c *conversation) Interrupt(ctx context.Context, providerTurnID string) error {
	if providerTurnID == "" {
		c.mu.Lock()
		providerTurnID = c.activeTurn
		c.mu.Unlock()
	}
	if providerTurnID == "" {
		return ports.ErrChatNoActiveTurn
	}
	if err := c.conn.request(ctx, "turn/interrupt", map[string]any{
		"threadId": c.threadID,
		"turnId":   providerTurnID,
	}, nil); err != nil {
		// The provider refuses an interrupt for a turn it does not consider
		// active — which happens either side of the turn: pressed before it has
		// acknowledged the start, or after it already finished. Neither is an
		// internal failure, so it is translated here, where the provider's
		// vocabulary is known, instead of escaping as a protocol error and
		// reaching the user as "Internal server error".
		if isNoActiveTurn(err) {
			return ports.ErrChatNoActiveTurn
		}
		return fmt.Errorf("turn/interrupt: %w", err)
	}
	return nil
}

// isNoActiveTurn recognizes the provider's "nothing to interrupt" refusal.
//
// Matched on the message because that is all app-server gives: the code is the
// generic -32600 it uses for any invalid request, so the code alone cannot
// distinguish this from a malformed call.
func isNoActiveTurn(err error) bool {
	var rpcErr *rpcError
	if !errors.As(err, &rpcErr) {
		return false
	}
	return strings.Contains(strings.ToLower(rpcErr.Message), "no active turn")
}

// ResolveRequest answers a parked approval or user-input request.
//
// The decision is checked against the set the provider offered for THIS request,
// and the request stays parked unless a valid answer is actually going through.
// Both halves matter: forwarding an invented decision is consent AO made up, and
// consuming the request on a bad one would leave the user's real answer with
// nothing left to answer while the provider waits out its timeout.
func (c *conversation) ResolveRequest(ctx context.Context, requestID string, decision ports.ChatDecision) error {
	c.mu.Lock()
	parked, ok := c.pending[requestID]
	closed := c.closed
	if closed {
		c.mu.Unlock()
		return errConversationClosed
	}
	if !ok {
		c.mu.Unlock()
		// Already resolved, superseded, or from a previous controller. Refusing is
		// required: a stale card must never resolve a newer request.
		return fmt.Errorf("%w: %q", ports.ErrChatRequestNotPending, requestID)
	}
	reply, err := parked.reply(decision)
	if err != nil {
		c.mu.Unlock()
		return err
	}
	delete(c.pending, requestID)
	c.mu.Unlock()

	select {
	case parked.ch <- reply:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// parkedRequest is one server-to-client request waiting on a person, together
// with the decisions the provider said were valid for it.
//
// Keeping the provider's own payload for each decision is what makes structured
// decisions answerable at all: some arrive as objects carrying parameters
// (acceptWithExecpolicyAmendment), and a client that only knows the id cannot
// reconstruct them. AO echoes what the provider sent rather than rebuilding it.
type parkedRequest struct {
	ch      chan ports.ChatDecision
	method  string
	offered map[string]json.RawMessage
}

// reply resolves a client decision into the payload to send back.
func (p *parkedRequest) reply(decision ports.ChatDecision) (ports.ChatDecision, error) {
	if p.method == "item/tool/requestUserInput" {
		// Not a decision but an answer: the provider offers questions, not options,
		// so there is no set to check it against.
		return decision, nil
	}
	raw, ok := p.offered[decision.ID]
	if !ok {
		return ports.ChatDecision{}, fmt.Errorf("%w: %q (offered: %s)",
			ports.ErrChatDecisionNotOffered, decision.ID, strings.Join(p.offeredIDs(), ", "))
	}
	// The provider's own encoding of the decision wins over whatever the client
	// sent, so an object-shaped decision round-trips exactly.
	decision.Raw = raw
	return decision, nil
}

func (p *parkedRequest) offeredIDs() []string {
	ids := make([]string, 0, len(p.offered))
	for id := range p.offered {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
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

	offered := make(map[string]json.RawMessage, len(decisions))
	for _, option := range decisions {
		offered[option.ID] = option.Raw
	}

	ch := make(chan ports.ChatDecision, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errConversationClosed
	}
	c.pending[requestID] = &parkedRequest{ch: ch, method: req.Method, offered: offered}
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
	c.pending = map[string]*parkedRequest{}
	c.closed = true
	c.mu.Unlock()
	for _, parked := range pending {
		close(parked.ch)
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
