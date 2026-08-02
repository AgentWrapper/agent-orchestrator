package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// eventBuffer bounds the normalized event stream. Deltas are dropped when a
// consumer falls this far behind; lifecycle events are not.
const eventBuffer = 4096

// approvalWait bounds how long the CLI is left blocked on an unanswered request.
// It holds the tool call until the client replies, so an approval nobody resolves
// would hang the session indefinitely. On expiry AO refuses rather than deciding
// on the user's behalf.
const approvalWait = 30 * time.Minute

// errConversationClosed reports a decision arriving after the controller ended.
var errConversationClosed = errors.New("conversation closed")

// The two decisions the permission protocol always accepts. They are not invented
// options: `behavior` is a closed union of exactly these in the CLI's own type
// declaration, and both were exercised end to end against claude 2.1.220.
const (
	decisionAllow = "allow"
	decisionDeny  = "deny"
)

// conversation is one live Claude Code session. It is the only writer to that
// session.
type conversation struct {
	conn *conn
	proc *process
	log  *slog.Logger
	norm *normalizer

	// sessionID is the CLI's session id, which AO minted at Start and passed in
	// with --session-id. Persisting it is what makes resume possible, and having
	// it before the first turn is why AO mints it rather than reading it off the
	// first system/init.
	sessionID string
	events    chan ports.ChatEvent

	mu      sync.Mutex
	pending map[string]*parkedRequest
	closed  bool

	// sendMu serializes dispatch so only one operation mutates the CLI session at
	// a time.
	sendMu sync.Mutex

	// activeTurn is the turn currently in flight, or empty when the agent is idle.
	// It is what an interrupt with no named turn targets, and what tells a named
	// interrupt whether it arrived in time.
	activeTurn string

	// emitMu guards the event channel's lifetime rather than the conversation's
	// state, which is why it is separate from mu.
	//
	// Approvals are emitted from the connection's own handler goroutine, not from
	// the pump, so a conversation ending while a card is being raised would
	// otherwise send on a closed channel and take the daemon down. Read-locked by
	// every sender so they do not serialize with each other; write-locked once, to
	// close.
	emitMu       sync.RWMutex
	eventsClosed bool

	pumpDone  chan struct{}
	closeOnce sync.Once
}

var _ ports.ChatConversation = (*conversation)(nil)

// Asserted here so a refactor cannot silently drop one of these: the service
// feature-detects each interface, and a missing method would read as "the CLI
// cannot do this" with nothing anywhere to notice.
var (
	_ ports.ChatModelLister   = (*conversation)(nil)
	_ ports.ChatUsageReporter = (*conversation)(nil)
	_ ports.ChatRenamer       = (*conversation)(nil)
	_ ports.ChatCompactor     = (*conversation)(nil)
)

func newConversation(proc *process, log *slog.Logger) *conversation {
	c := &conversation{
		proc:     proc,
		log:      log,
		norm:     newNormalizer(),
		events:   make(chan ports.ChatEvent, eventBuffer),
		pending:  make(map[string]*parkedRequest),
		pumpDone: make(chan struct{}),
	}
	c.conn = newConn(proc.stdin, proc.stdout, log, c.handleControlRequest)
	return c
}

// start records the session and begins translating frames. It is called once,
// after the handshake, so no event is emitted for a conversation the caller does
// not yet have a handle to.
func (c *conversation) start(sessionID string) {
	c.sessionID = sessionID
	go c.pump()
}

// ProviderConversationID is the Claude session id AO persists for resume.
func (c *conversation) ProviderConversationID() string { return c.sessionID }

// Capabilities reports what this conversation can do.
func (c *conversation) Capabilities() ports.ChatCapabilities { return capabilities() }

// Events is the normalized stream. It closes when the conversation ends.
func (c *conversation) Events() <-chan ports.ChatEvent { return c.events }

// pump translates CLI frames into neutral events until the connection ends, then
// reports why and closes the stream.
func (c *conversation) pump() {
	defer close(c.pumpDone)
	defer c.closeEvents()

	for f := range c.conn.notifs() {
		// The clock is passed in rather than read inside: a rate-limit reset arrives
		// as an absolute instant and has to become a remaining duration, and a
		// normalizer that reads the clock itself cannot be tested deterministically.
		for _, ev := range c.norm.normalize(f, time.Now()) {
			if ev.Kind == ports.ChatEventTurnCompleted {
				// The agent is idle again, so a later interrupt has nothing to
				// cancel. Cleared here rather than in Interrupt because the turn
				// ending is the CLI's news, not the caller's.
				c.mu.Lock()
				if c.activeTurn == ev.ProviderTurnID {
					c.activeTurn = ""
				}
				c.mu.Unlock()
			}
			c.emit(ev)
		}
	}

	// The connection ended. Say so explicitly rather than letting the stream go
	// quiet: a silent channel close is indistinguishable from an idle agent.
	state := ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerStopped}
	if err := c.conn.err(); err != nil {
		state.Err = err
	} else if stderr := c.stderrTail(); stderr != "" {
		// The CLI reports its startup refusals on stderr and then exits cleanly, so
		// without this the user gets a controller that stopped for no stated reason.
		state.Err = fmt.Errorf("claude exited: %s", stderr)
	}
	c.emit(state)
	c.failPendingApprovals()
}

// emit delivers an event, preferring to drop a delta over blocking the reader. A
// lifecycle event is never dropped silently.
func (c *conversation) emit(ev ports.ChatEvent) {
	// Held for the whole send. Approvals are emitted from the connection's handler
	// goroutine, so without this a conversation ending mid-card would send on a
	// closed channel.
	c.emitMu.RLock()
	defer c.emitMu.RUnlock()
	if c.eventsClosed {
		return
	}

	select {
	case c.events <- ev:
		return
	default:
	}

	if ev.Kind == ports.ChatEventMessageDelta {
		// The settled text arrives on the assistant frame, so a dropped delta
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

// closeEvents ends the stream once every in-flight sender has finished.
func (c *conversation) closeEvents() {
	c.emitMu.Lock()
	defer c.emitMu.Unlock()
	if c.eventsClosed {
		return
	}
	c.eventsClosed = true
	close(c.events)
}

// stderrTail is the CLI's last words, or "" for a process that never had a
// stderr reader (which is how the transport tests construct one).
func (c *conversation) stderrTail() string {
	if c.proc == nil || c.proc.stderrTail == nil {
		return ""
	}
	return c.proc.stderrTail()
}

// SendTurn delivers one message to the CLI.
//
// Unlike an app-server's turn/start, this is fire-and-forget: the CLI answers a
// user message by starting work, not by acknowledging it. So the turn id is AO's
// own, minted here, and recorded on the normalizer BEFORE the message goes out so
// the first frame the CLI emits is already correlated.
func (c *conversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if strings.TrimSpace(msg.Text) == "" {
		// There is no keystroke concept here: an empty message is a caller bug, not
		// a way to nudge the agent.
		return ports.ChatTurnRef{}, errors.New("chat message text is empty")
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	// Applied before the message so the turn runs under the posture the caller
	// asked for. A refusal fails the send rather than quietly running under the
	// old one: silently using a different model or a laxer approval policy than
	// the user chose is worse than not running the turn.
	if err := c.applyTurnSettings(ctx, msg.Settings); err != nil {
		return ports.ChatTurnRef{}, err
	}

	turnID := c.mintTurn()

	// ClientMessageID is deliberately not forwarded. The CLI has no idempotency
	// key on this frame, so there is nothing to hand it; AO's own turn table is
	// what makes a retry safe, and inventing a field the CLI ignores would only
	// look like protection that is not there.
	if err := c.sendText(msg.Text); err != nil {
		c.abandonTurn()
		return ports.ChatTurnRef{}, fmt.Errorf("send user message: %w", err)
	}

	return ports.ChatTurnRef{ProviderTurnID: turnID}, nil
}

// mintTurn assigns the id this turn will be known by. It is recorded before the
// message goes out so the first frame the CLI emits is already correlated: the
// reader runs on its own goroutine and can see a response before the writer has
// returned.
//
// A UUID rather than a counter, and the difference is not cosmetic. AO's store
// holds provider turn ids UNIQUE per conversation, and a conversation outlives the
// process that serves it: after a daemon restart a per-process counter starts at
// one again and the first turn collides with the first turn of the previous run.
// Measured — the restart scenario failed on exactly that constraint. The "ao-"
// prefix marks the id as AO's own, since the CLI has no turn identity to borrow.
func (c *conversation) mintTurn() string {
	turnID := "ao-" + uuid.NewString()
	c.mu.Lock()
	c.activeTurn = turnID
	c.mu.Unlock()
	c.norm.beginTurn(turnID)
	return turnID
}

// abandonTurn undoes mintTurn for a message that never left. Without it a failed
// write would leave a turn id that no result will ever settle, and the next
// interrupt would be answered for a turn that was never started.
func (c *conversation) abandonTurn() {
	c.norm.endTurn()
	c.mu.Lock()
	c.activeTurn = ""
	c.mu.Unlock()
}

// sendText writes one user message frame.
func (c *conversation) sendText(text string) error {
	return c.conn.send(map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": []any{map[string]any{"type": "text", "text": text}},
		},
	})
}

// applyTurnSettings folds the caller's per-turn choices into the CLI session.
//
// Each is a separate control request because the CLI has no combined one, and
// only fields the caller actually chose are sent: an omitted field leaves the
// session as it was, which is what makes a caller that chooses nothing behave
// exactly as it did before per-turn settings existed.
func (c *conversation) applyTurnSettings(ctx context.Context, settings ports.ChatTurnSettings) error {
	if settings.IsZero() {
		return nil
	}
	if settings.Model != "" {
		if err := c.conn.request(ctx, "set_model", map[string]any{"model": settings.Model}, nil); err != nil {
			return fmt.Errorf("set model %q: %w", settings.Model, err)
		}
	}
	if settings.Effort != "" {
		// effortLevel rides the flag-settings layer rather than a dedicated subtype;
		// that layer is session-scoped, which is also the only place "max" is
		// accepted. Measured caveat: the CLI answers success for a level it does not
		// recognize, so nothing here can confirm the effort took. That is why the
		// levels offered come from list_models' supportedEffortLevels for the chosen
		// model and are never assembled by AO.
		if err := c.conn.request(ctx, "apply_flag_settings", map[string]any{
			"settings": map[string]any{"effortLevel": settings.Effort},
		}, nil); err != nil {
			return fmt.Errorf("set effort %q: %w", settings.Effort, err)
		}
	}
	if settings.Approval != "" {
		mode := permissionMode(settings.Approval)
		if mode == "" {
			// AO's default means "whatever the user configured", and the CLI's own
			// name for that is the literal string "default", which set_permission_mode
			// accepts even though --permission-mode does not list it.
			mode = "default"
		}
		if err := c.conn.request(ctx, "set_permission_mode", map[string]any{"mode": mode}, nil); err != nil {
			// The CLI refuses an escalation to bypassPermissions unless the process
			// was launched permissively. That is the correct answer to give a user
			// trying to widen a session they deliberately constrained, so it is
			// surfaced with the CLI's own wording rather than swallowed.
			return fmt.Errorf("set permission mode %q: %w", mode, err)
		}
	}
	return nil
}

// Interrupt cancels a turn. An empty turn id targets the active one.
func (c *conversation) Interrupt(ctx context.Context, providerTurnID string) error {
	c.mu.Lock()
	active := c.activeTurn
	c.mu.Unlock()

	if providerTurnID == "" {
		providerTurnID = active
	}
	if providerTurnID == "" || providerTurnID != active {
		// Either nothing is running, or the caller named a turn that is no longer
		// the live one. Pressing stop a moment too late is an ordinary thing for a
		// person to do, so it is reported as "nothing to cancel" rather than as an
		// internal failure. AO has to make this judgement itself: the CLI's
		// interrupt takes no turn id and answers success either way, so it cannot
		// tell AO that the turn was already over.
		return ports.ErrChatNoActiveTurn
	}

	// cancel_queued is deliberately not set. AO runs its own message queue and
	// drains it a turn at a time, so the CLI never holds queued work of its own;
	// asking it to cancel a queue that is always empty would be a claim about a
	// mechanism AO does not use.
	if err := c.conn.request(ctx, "interrupt", nil, nil); err != nil {
		return fmt.Errorf("interrupt: %w", err)
	}
	return nil
}

// ResolveRequest answers a parked approval.
//
// The decision is checked against the set offered for THIS request, and the
// request stays parked unless a valid answer is actually going through. Both
// halves matter: forwarding an invented decision is consent AO made up, and
// consuming the request on a bad one would leave the user's real answer with
// nothing left to answer while the CLI waits out its timeout.
func (c *conversation) ResolveRequest(ctx context.Context, requestID string, decision ports.ChatDecision) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errConversationClosed
	}
	parked, ok := c.pending[requestID]
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

// parkedRequest is one control_request waiting on a person, together with the
// replies the CLI said were valid for it.
//
// The prepared reply body is stored per decision rather than rebuilt at answer
// time. An "allow and always permit this" decision carries a whole permission
// amendment the CLI offered, and a client that only knows the decision's id
// cannot reconstruct it — so AO echoes back what the CLI sent instead of
// composing its own version of the user's consent.
type parkedRequest struct {
	ch      chan json.RawMessage
	offered map[string]json.RawMessage
}

// reply resolves a client decision into the payload to send back.
func (p *parkedRequest) reply(decision ports.ChatDecision) (json.RawMessage, error) {
	body, ok := p.offered[decision.ID]
	if !ok {
		return nil, fmt.Errorf("%w: %q (offered: %s)",
			ports.ErrChatDecisionNotOffered, decision.ID, strings.Join(p.offeredIDs(), ", "))
	}
	return body, nil
}

func (p *parkedRequest) offeredIDs() []string {
	ids := make([]string, 0, len(p.offered))
	for id := range p.offered {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// handleControlRequest parks a CLI request until a decision arrives.
//
// The CLI blocks the tool call on the reply, so this deliberately waits rather
// than answering immediately. Everything AO does not model is refused with an
// error, never with a fabricated decision.
func (c *conversation) handleControlRequest(ctx context.Context, req serverRequest) (any, error) {
	if req.Subtype != "can_use_tool" {
		// request_user_dialog is the notable other inbound subtype. AO never
		// declares supportedDialogKinds at initialize, and the CLI's contract is
		// that an undeclared kind degrades to its no-dialog behavior instead of
		// being parked — so one arriving here means a kind AO has no surface for,
		// and refusing is the only answer that is not a guess at the user's intent.
		c.log.Warn("refusing unmodelled claude control request", "subtype", req.Subtype)
		return nil, fmt.Errorf("unsupported request %s", req.Subtype)
	}
	if req.ID == "" {
		return nil, errors.New("control request carried no id")
	}

	ask := parsePermissionRequest(req.Params)
	decisions, replies := permissionDecisions(ask)

	ch := make(chan json.RawMessage, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errConversationClosed
	}
	c.pending[req.ID] = &parkedRequest{ch: ch, offered: replies}
	c.mu.Unlock()

	c.emit(ports.ChatEvent{
		Kind:           ports.ChatEventApprovalRequested,
		ProviderTurnID: c.norm.currentTurn(),
		// The REQUEST id, not the tool_use id, and deliberately its own timeline row
		// rather than an update to the tool call's.
		//
		// Keying it on the tool_use looked tidier and was wrong twice over: the
		// store's upsert only rewrites status, summary, and detail for an existing
		// item, so the request id never got stored and nothing could answer the
		// card; and the row kept the tool call's kind, so a pending approval was not
		// discoverable as an approval at all. Measured — the approval scenario
		// waited out its full timeout on a card that was sitting right there.
		ProviderItemID: req.ID,
		RequestID:      req.ID,
		// One kind for every ask, because the CLI has one ask. Unlike an app-server
		// with a method per approval sort, can_use_tool covers commands, edits, and
		// policy escalations alike; the tool it is about travels in the detail, which
		// is where provider specifics belong.
		ActivityKind:   domain.ActivityKindApproval,
		ActivityStatus: domain.ActivityStatusPending,
		Summary:        approvalSummary(ask),
		Detail:         approvalDetail(ask),
		Decisions:      decisions,
	})

	select {
	case reply, ok := <-ch:
		if !ok {
			return nil, errConversationClosed
		}
		return reply, nil

	case <-time.After(approvalWait):
		c.discardPending(req.ID)
		return nil, errors.New("approval timed out without a decision")

	case <-ctx.Done():
		c.discardPending(req.ID)
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

// Close releases the controller without touching the CLI's stored history.
func (c *conversation) Close() error {
	c.closeOnce.Do(func() {
		c.failPendingApprovals()
		if c.proc.stop != nil {
			_ = c.proc.stop()
		}
	})
	return nil
}

// permissionAsk is the subset of a can_use_tool request AO renders.
type permissionAsk struct {
	ToolName string          `json:"tool_name"`
	Input    json.RawMessage `json:"input"`
	// PermissionSuggestions is the CLI's own list of amendments it would accept
	// alongside an allow: a rule to remember, a directory to trust, a mode to
	// switch to. It is Claude's analogue of an app-server's availableDecisions,
	// and the reason the offered set is built per request instead of fixed.
	PermissionSuggestions []json.RawMessage `json:"permission_suggestions"`
	// SuppressAlwaysAllowRule marks an ask whose persistent-rule affordance must
	// not be shown: accepting it would write an allow rule broader than the ask.
	SuppressAlwaysAllowRule bool   `json:"suppress_always_allow_rule"`
	BlockedPath             string `json:"blocked_path"`
	DecisionReason          string `json:"decision_reason"`
	DecisionReasonType      string `json:"decision_reason_type"`
	Title                   string `json:"title"`
	DisplayName             string `json:"display_name"`
	Description             string `json:"description"`
	ToolUseID               string `json:"tool_use_id"`
	AgentID                 string `json:"agent_id"`
	// RequiresUserInteraction marks an ask the CLI says cannot be answered with a
	// one-tap approve or deny.
	RequiresUserInteraction bool `json:"requires_user_interaction"`
}

func parsePermissionRequest(params json.RawMessage) permissionAsk {
	var ask permissionAsk
	if err := json.Unmarshal(params, &ask); err != nil {
		return permissionAsk{}
	}
	return ask
}

// permissionSuggestion is the shape of one entry of permission_suggestions, read
// only far enough to label it. The whole object is echoed back untouched.
type permissionSuggestion struct {
	Type        string `json:"type"`
	Mode        string `json:"mode"`
	Destination string `json:"destination"`
	Rules       []struct {
		ToolName    string `json:"toolName"`
		RuleContent string `json:"ruleContent"`
	} `json:"rules"`
	Directories []string `json:"directories"`
}

// permissionDecisions builds the choices to offer and the reply body for each.
//
// allow and deny are always offered because `behavior` is a two-value union in
// the protocol itself: they are what the CLI accepts, not a set AO decided on.
// Everything beyond them comes from the CLI's own suggestions, so a build that
// offers a new kind of amendment renders as a usable button without a code
// change here.
func permissionDecisions(ask permissionAsk) ([]ports.ChatDecisionOption, map[string]json.RawMessage) {
	allow := map[string]any{"behavior": decisionAllow}
	if len(ask.Input) > 0 {
		// Echoed back unchanged. The field exists so a host can edit a command
		// before approving it; AO does not offer that, and sending anything other
		// than what the model asked for would be approving a different action than
		// the one on the card.
		allow["updatedInput"] = ask.Input
	}

	options := []ports.ChatDecisionOption{
		{ID: decisionAllow, Label: "Approve", Raw: mustEncode(allow)},
		{ID: decisionDeny, Label: "Deny", Raw: mustEncode(map[string]any{
			"behavior": decisionDeny,
			"message":  "The user declined this action.",
		})},
	}
	replies := map[string]json.RawMessage{
		decisionAllow: options[0].Raw,
		decisionDeny:  options[1].Raw,
	}

	if ask.SuppressAlwaysAllowRule {
		// The CLI says a persistent rule from this ask would be broader than the
		// ask itself. Offering it anyway would let one approval quietly grant more
		// than the user was looking at.
		return options, replies
	}

	for i, raw := range ask.PermissionSuggestions {
		var suggestion permissionSuggestion
		if err := json.Unmarshal(raw, &suggestion); err != nil || suggestion.Type == "" {
			continue
		}
		id := suggestionID(suggestion, i)
		if _, taken := replies[id]; taken {
			id = id + "-" + strconv.Itoa(i)
		}
		body := mustEncode(map[string]any{
			"behavior":           decisionAllow,
			"updatedInput":       nonEmptyJSON(ask.Input),
			"updatedPermissions": []json.RawMessage{raw},
		})
		options = append(options, ports.ChatDecisionOption{
			ID:    id,
			Label: suggestionLabel(suggestion),
			// The CLI's own encoding of the amendment, so a client can show exactly
			// what it is being asked to remember.
			Raw: raw,
		})
		replies[id] = body
	}
	return options, replies
}

// suggestionID names an amendment stably enough for a client to send it back.
func suggestionID(s permissionSuggestion, index int) string {
	switch s.Type {
	case "setMode":
		if s.Mode != "" {
			return "allowAndSetMode:" + s.Mode
		}
	case "addRules":
		return "allowAndAddRule"
	case "addDirectories":
		return "allowAndAddDirectory"
	}
	return "allowWith:" + s.Type + ":" + strconv.Itoa(index)
}

// suggestionLabel renders an amendment as something a person can consent to. An
// unrecognized type falls back to its own name rather than being hidden, so a new
// CLI suggestion still reaches the user.
func suggestionLabel(s permissionSuggestion) string {
	switch s.Type {
	case "setMode":
		switch s.Mode {
		case "acceptEdits":
			return "Approve and accept edits for this session"
		case "bypassPermissions":
			return "Approve and stop asking for this session"
		default:
			return "Approve and switch to " + s.Mode
		}
	case "addRules":
		if len(s.Rules) > 0 {
			rule := s.Rules[0].ToolName
			if s.Rules[0].RuleContent != "" {
				rule += "(" + s.Rules[0].RuleContent + ")"
			}
			return "Approve and always allow " + truncateLabel(rule)
		}
		return "Approve and remember this rule"
	case "addDirectories":
		if len(s.Directories) > 0 {
			return "Approve and allow " + shortPath(s.Directories[0])
		}
		return "Approve and allow this directory"
	default:
		return "Approve with " + s.Type
	}
}

// approvalSummary labels the card.
//
// The CLI's own title is preferred over anything AO could compose: it is what the
// interactive client shows, so the two surfaces say the same thing about the same
// action. Only when the ask carries no title does AO derive one from the tool
// call, and the CLI's display_name is the last fallback before a bare label.
func approvalSummary(ask permissionAsk) string {
	if title := strings.TrimSpace(ask.Title); title != "" {
		return truncateLabel(title)
	}
	if _, summary := toolActivity(ask.ToolName, ask.Input); summary != "" {
		return summary
	}
	if name := strings.TrimSpace(ask.DisplayName); name != "" {
		return "Approve " + truncateLabel(name)
	}
	return "Approval required"
}

// approvalDetail is the neutral payload AO persists for an approval.
func approvalDetail(ask permissionAsk) []byte {
	detail := map[string]any{}
	if ask.ToolName != "" {
		detail["toolName"] = ask.ToolName
	}
	if ask.ToolUseID != "" {
		// The tool call this ask is about. Carried so a client can tie the card back
		// to the activity row the tool_use created, which is what the approval's own
		// item id deliberately no longer does.
		detail["toolUseId"] = ask.ToolUseID
	}
	if len(ask.Input) > 0 && string(ask.Input) != "null" {
		detail["input"] = ask.Input
	}
	if ask.Description != "" {
		detail["description"] = ask.Description
	}
	if ask.DecisionReason != "" {
		// The CLI's stated reason the ask escalated. Its own docs warn it may carry
		// ANSI escapes and is producer-authored, so it is stored as data for a
		// client to sanitize and never interpreted here.
		detail["reason"] = ask.DecisionReason
	}
	if ask.DecisionReasonType != "" {
		detail["reasonType"] = ask.DecisionReasonType
	}
	if ask.BlockedPath != "" {
		detail["blockedPath"] = ask.BlockedPath
	}
	if ask.AgentID != "" {
		// The ask came from a subagent, which is worth saying: the user asked the
		// main agent for something and is being prompted by a delegate.
		detail["agentId"] = ask.AgentID
	}
	if ask.RequiresUserInteraction {
		// The CLI says this one is meant to be answered on the tool's own card.
		// Recorded rather than acted on: AO's chat surface is the only surface the
		// user has here, so withholding the approve button would leave them able to
		// say no and never yes.
		detail["requiresUserInteraction"] = true
	}
	return encodeDetail(detail)
}

// ListModels asks the CLI which models this account may use.
//
// The CLI is the only honest source: models get added, renamed, hidden per
// account, and gated by entitlement AO cannot see. A table in AO would be wrong
// within a week.
func (c *conversation) ListModels(ctx context.Context) ([]ports.ChatModel, error) {
	// Each entry also carries resolvedModel (what "sonnet" currently means) and
	// several fast-mode flags. Not read: the id AO sends back is `value`, and
	// resolving it is the CLI's job, not something AO should second-guess.
	var resp struct {
		Models []struct {
			Value          string   `json:"value"`
			DisplayName    string   `json:"displayName"`
			Description    string   `json:"description"`
			SupportsEffort bool     `json:"supportsEffort"`
			EffortLevels   []string `json:"supportedEffortLevels"`
		} `json:"models"`
	}
	if err := c.conn.request(ctx, "list_models", nil, &resp); err != nil {
		return nil, fmt.Errorf("list_models: %w", err)
	}

	models := make([]ports.ChatModel, 0, len(resp.Models))
	for _, entry := range resp.Models {
		if entry.Value == "" {
			continue
		}
		model := ports.ChatModel{
			ID:          entry.Value,
			DisplayName: firstNonEmpty(entry.DisplayName, entry.Value),
			Description: entry.Description,
			// The CLI expresses "whatever this account is configured for" as a
			// model entry of its own rather than as a flag on another one, so that
			// entry is the default.
			Default: entry.Value == "default",
		}
		if entry.SupportsEffort {
			model.Efforts = entry.EffortLevels
		}
		models = append(models, model)
	}
	return models, nil
}

// ReadRateLimits reads where the account stands right now.
//
// The pushed rate_limit_event is one window and, on the account this was measured
// against, carried no percentage at all. This read is where both windows and
// their utilization actually come from, which is why the capability rests on it
// rather than on the notification.
func (c *conversation) ReadRateLimits(ctx context.Context) (ports.ChatRateLimits, error) {
	var resp usageReadResponse
	if err := c.conn.request(ctx, "get_usage", nil, &resp); err != nil {
		return ports.ChatRateLimits{}, fmt.Errorf("get_usage: %w", err)
	}
	return rateLimitsFrom(resp, time.Now()), nil
}

// usageReadResponse is the get_usage result. Only the quota half is read: the cost
// and per-model breakdown alongside it answer a different question, and the meter's
// job is to say whether the account is near a wall.
//
// rate_limits is decoded as raw values rather than as a map of windows because it
// is NOT uniformly shaped. Measured on a live account, the same object carries
// window objects (five_hour, seven_day), nulls for windows the account has no
// entitlement for, an unrelated object (extra_usage, spend), an array (limits,
// model_scoped), and a bool (member_dashboard_available). A typed map made the
// whole read fail on the first non-window sibling — which is exactly how it was
// found, by the live test rather than by a fixture.
type usageReadResponse struct {
	SubscriptionType    string                     `json:"subscription_type"`
	RateLimitsAvailable bool                       `json:"rate_limits_available"`
	RateLimits          map[string]json.RawMessage `json:"rate_limits"`
}

// window is one quota window. resets_at is an RFC3339 timestamp here, unlike the
// unix seconds the pushed rate_limit_event uses for the same idea.
type window struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

// namedWindow reads one quota window by name, or nil when the account has no such
// window or the key holds something that is not one.
func (r usageReadResponse) namedWindow(name string) *window {
	raw, ok := r.RateLimits[name]
	if !ok || len(raw) == 0 {
		return nil
	}
	var w window
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil
	}
	return &w
}

// rateLimitsFrom converts a quota read into AO's neutral shape.
//
// A window the account does not have comes back null and is reported as a
// negative percent, because the port's contract is that negative means "not
// reported" — zero would claim the quota is untouched, which is a different and
// much more reassuring statement than "no such window". The absolute reset
// instant becomes a remaining duration so a client showing "resets in 4h" does
// not have to trust that AO's clock and the CLI's agree.
func rateLimitsFrom(resp usageReadResponse, now time.Time) ports.ChatRateLimits {
	limits := ports.ChatRateLimits{
		PrimaryUsedPercent:   -1,
		SecondaryUsedPercent: -1,
		PlanLabel:            resp.SubscriptionType,
	}
	// five_hour is the window that bites first and seven_day the one that decides
	// the week, which is the same short/long pairing the port's primary and
	// secondary describe. The response also carries a dozen further named windows
	// (per-model, overage, and several this account has no entitlement for); they
	// are a finer answer to a question the user has not asked yet.
	if w := resp.namedWindow("five_hour"); w != nil && w.Utilization != nil {
		limits.PrimaryUsedPercent = *w.Utilization
		limits.PrimaryResetsInSeconds = secondsUntil(w.ResetsAt, now)
	}
	if w := resp.namedWindow("seven_day"); w != nil && w.Utilization != nil {
		limits.SecondaryUsedPercent = *w.Utilization
		limits.SecondaryResetsInSeconds = secondsUntil(w.ResetsAt, now)
	}
	return limits
}

// secondsUntil turns an RFC3339 instant into seconds from now, floored at zero: a
// window whose reset has already passed has nothing left to wait for.
func secondsUntil(timestamp string, now time.Time) int64 {
	if timestamp == "" {
		return 0
	}
	at, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		return 0
	}
	remaining := int64(at.Sub(now).Seconds())
	if remaining < 0 {
		return 0
	}
	return remaining
}

// SetTitle names the session CLI-side.
//
// Nothing is written to AO's rows here, and unlike Codex there is no notification
// to read the result back from: the CLI answers a bare success and never mentions
// the title again. So this reports only whether the CLI accepted it, and AO's own
// title handling stays the caller's job.
func (c *conversation) SetTitle(ctx context.Context, title string) error {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return errors.New("thread title must not be empty")
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	if err := c.conn.request(ctx, "rename_session", map[string]any{"title": trimmed}, nil); err != nil {
		return fmt.Errorf("rename_session: %w", err)
	}
	return nil
}

// Compact asks the CLI to summarize earlier history and reclaim context.
//
// This is what keeps a long session usable: every turn re-sends the conversation,
// so context fills whether or not the user is doing anything unusual, and once it
// is full the session cannot accept another turn at all.
//
// It is sent as a "/compact" TURN rather than over the control channel, because
// the control channel has no compaction subtype — the CLI's own compaction is a
// slash command, and a slash command on this wire is a user message the CLI
// intercepts before the model sees it. Verified against claude 2.1.220: sending
// "/compact" produced the CLI's own refusal ("Not enough messages to compact."),
// which is the command answering, not the model repeating the text back.
//
// A turn id is minted for it exactly as SendTurn does, so the frames it produces
// are correlated and the Chat controller can adopt the turn it never dispatched.
// The reclaim itself is reported later, on the compact_boundary frame, which
// states both sides outright; TokensBefore here is a courtesy read so a caller
// has something to show immediately.
func (c *conversation) Compact(ctx context.Context) (ports.ChatCompactionResult, error) {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	before := c.readContextTokens(ctx)

	turnID := c.mintTurn()
	if err := c.sendText("/compact"); err != nil {
		c.abandonTurn()
		return ports.ChatCompactionResult{}, fmt.Errorf("send /compact: %w", err)
	}
	c.log.Debug("requested claude compaction", "session", c.sessionID, "turn", turnID)

	// TokensAfter stays zero: the compaction runs as its own turn and the settled
	// figures reach the client as a ChatEventCompacted on the timeline. Blocking
	// here would hold the dispatch lock for the duration and make the whole
	// conversation unresponsive while it ran.
	return ports.ChatCompactionResult{TokensBefore: before}, nil
}

// readContextTokens is the conversation's current position in the context window,
// or zero when the CLI will not say. Best-effort on purpose: a compaction must
// not fail because the figure it would have been labelled with was unavailable.
func (c *conversation) readContextTokens(ctx context.Context) int64 {
	var resp struct {
		TotalTokens int64 `json:"totalTokens"`
	}
	if err := c.conn.request(ctx, "get_context_usage", nil, &resp); err != nil {
		c.log.Debug("could not read claude context usage", "error", err)
		return 0
	}
	return resp.TotalTokens
}

func mustEncode(v any) json.RawMessage {
	encoded, err := json.Marshal(v)
	if err != nil {
		// Every caller passes a map of strings and pre-validated raw JSON, so this
		// is unreachable; an empty body is still safer than a panic in a driver.
		return json.RawMessage("{}")
	}
	return encoded
}

func nonEmptyJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	return raw
}
