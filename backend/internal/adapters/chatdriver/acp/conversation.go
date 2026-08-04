package acp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	eventBuffer  = 4096
	approvalWait = 30 * time.Minute
)

var (
	errConversationClosed = errors.New("ACP conversation closed")
	errClientCapability   = errors.New("ACP client capability not advertised")
)

type preparedTurn struct {
	id      string
	message ports.ChatUserMessage
}

type parkedPermission struct {
	options map[string]acpsdk.PermissionOption
	result  chan string
}

type toolState struct {
	id        string
	title     string
	kind      acpsdk.ToolKind
	status    acpsdk.ToolCallStatus
	locations []acpsdk.ToolCallLocation
	content   []acpsdk.ToolCallContent
	rawInput  any
	rawOutput any
}

type conversation struct {
	conn *acpsdk.ClientSideConnection
	proc *process
	log  *slog.Logger

	mu            sync.Mutex
	sessionID     string
	capabilities  ports.ChatCapabilities
	prepared      *preparedTurn
	activeTurn    string
	turnCancel    context.CancelFunc
	pending       map[string]*parkedPermission
	messages      map[string]string
	thoughts      map[string]string
	tools         map[string]*toolState
	configOptions []ports.ChatConfigOption
	skills        []ports.ChatSkill
	skillsKnown   bool
	closed        bool
	modeFor       func(ports.PermissionMode) string
	optionsFor    func(ports.ChatTurnSettings) []SessionOption

	eventMu      sync.RWMutex
	events       chan ports.ChatEvent
	eventsClosed bool
	closeOnce    sync.Once
}

var _ ports.ChatConversation = (*conversation)(nil)
var _ ports.ChatDeferredTurnStarter = (*conversation)(nil)
var _ ports.ChatConfigOptionController = (*conversation)(nil)
var _ ports.ChatSkillLister = (*conversation)(nil)
var _ ports.ChatSteerer = (*conversation)(nil)
var _ acpsdk.Client = (*conversation)(nil)

func newConversation(proc *process, log *slog.Logger) *conversation {
	c := &conversation{
		proc:     proc,
		log:      log,
		pending:  make(map[string]*parkedPermission),
		messages: make(map[string]string),
		thoughts: make(map[string]string),
		tools:    make(map[string]*toolState),
		events:   make(chan ports.ChatEvent, eventBuffer),
	}
	c.conn = acpsdk.NewClientSideConnection(c, proc.stdin, proc.stdout)
	c.conn.SetLogger(log)
	go c.watchConnection()
	return c
}

func (c *conversation) start(
	sessionID string,
	capabilities ports.ChatCapabilities,
	modeFor func(ports.PermissionMode) string,
	optionsFor func(ports.ChatTurnSettings) []SessionOption,
	configOptions []acpsdk.SessionConfigOption,
) {
	c.mu.Lock()
	c.sessionID = sessionID
	c.capabilities = capabilities
	c.configOptions = normalizeConfigOptions(configOptions)
	if len(c.configOptions) > 0 {
		c.capabilities[ports.ChatCapabilityConfigOptions] = true
	}
	if c.skillsKnown {
		c.capabilities[ports.ChatCapabilitySkills] = true
	}
	c.modeFor = modeFor
	c.optionsFor = optionsFor
	c.mu.Unlock()
	c.emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerReady})
}

func (c *conversation) ProviderConversationID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID
}

func (c *conversation) Capabilities() ports.ChatCapabilities {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneCapabilities(c.capabilities)
}

func (c *conversation) Events() <-chan ports.ChatEvent { return c.events }

// SendTurn prepares the long-lived ACP prompt request. AO's controller starts it
// through StartDeferredTurn only after the provider turn id is durable.
func (c *conversation) SendTurn(ctx context.Context, msg ports.ChatUserMessage) (ports.ChatTurnRef, error) {
	if err := ctx.Err(); err != nil {
		return ports.ChatTurnRef{}, err
	}
	if strings.TrimSpace(msg.Text) == "" {
		return ports.ChatTurnRef{}, errors.New("chat message text is empty")
	}
	c.mu.Lock()
	busy := c.closed || c.prepared != nil || c.activeTurn != ""
	c.mu.Unlock()
	if busy {
		return ports.ChatTurnRef{}, errors.New("ACP conversation already has a turn in flight")
	}
	if err := c.applyTurnSettings(ctx, msg.Settings); err != nil {
		return ports.ChatTurnRef{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return ports.ChatTurnRef{}, errConversationClosed
	}
	if c.prepared != nil || c.activeTurn != "" {
		return ports.ChatTurnRef{}, errors.New("ACP conversation already has a turn in flight")
	}
	id := uuid.NewString()
	c.prepared = &preparedTurn{id: id, message: msg}
	return ports.ChatTurnRef{ProviderTurnID: id}, nil
}

func (c *conversation) DiscardDeferredTurn(providerTurnID string) {
	c.mu.Lock()
	if c.prepared != nil && c.prepared.id == providerTurnID {
		c.prepared = nil
	}
	c.mu.Unlock()
}

func (c *conversation) applyTurnSettings(ctx context.Context, settings ports.ChatTurnSettings) error {
	c.mu.Lock()
	sessionID := c.sessionID
	modeFor := c.modeFor
	optionsFor := c.optionsFor
	c.mu.Unlock()
	if sessionID == "" {
		return errors.New("ACP session is not open")
	}
	if modeFor != nil {
		if mode := modeFor(settings.Approval); mode != "" {
			if _, err := c.conn.SetSessionMode(ctx, acpsdk.SetSessionModeRequest{
				SessionId: acpsdk.SessionId(sessionID), ModeId: acpsdk.SessionModeId(mode),
			}); err != nil {
				return fmt.Errorf("set ACP session mode %q: %w", mode, err)
			}
		}
	}
	if optionsFor != nil {
		for _, option := range optionsFor(settings) {
			if option.ID == "" || option.Value == "" {
				continue
			}
			resp, err := c.conn.SetSessionConfigOption(ctx, acpsdk.SetSessionConfigOptionRequest{
				ValueId: &acpsdk.SetSessionConfigOptionValueId{
					SessionId: acpsdk.SessionId(sessionID), ConfigId: acpsdk.SessionConfigId(option.ID),
					Value: acpsdk.SessionConfigValueId(option.Value),
				},
			})
			if err != nil {
				return fmt.Errorf("set ACP session option %q: %w", option.ID, err)
			}
			c.replaceConfigOptions(resp.ConfigOptions)
		}
	}
	return nil
}

func (c *conversation) StartDeferredTurn(providerTurnID string) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errConversationClosed
	}
	if c.prepared == nil || c.prepared.id != providerTurnID {
		c.mu.Unlock()
		return errors.New("ACP prepared turn not found")
	}
	turn := *c.prepared
	c.prepared = nil
	c.activeTurn = turn.id
	turnCtx, cancel := context.WithCancel(context.Background())
	c.turnCancel = cancel
	sessionID := c.sessionID
	c.messages = make(map[string]string)
	c.thoughts = make(map[string]string)
	c.tools = make(map[string]*toolState)
	c.mu.Unlock()

	go c.runTurn(turnCtx, sessionID, turn)
	return nil
}

func (c *conversation) runTurn(ctx context.Context, sessionID string, turn preparedTurn) {
	c.emit(ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: turn.id})
	c.emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerBusy})
	messageID := uuid.NewString()
	resp, err := c.conn.Prompt(ctx, acpsdk.PromptRequest{
		SessionId: acpsdk.SessionId(sessionID),
		MessageId: &messageID,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock(turn.message.Text)},
	})

	c.settleOpenItems(turn.id)
	state := domain.TurnStateCompleted
	if err != nil {
		if errors.Is(err, context.Canceled) {
			state = domain.TurnStateInterrupted
		} else {
			state = domain.TurnStateFailed
			c.emit(ports.ChatEvent{Kind: ports.ChatEventError, ProviderTurnID: turn.id, Err: err})
		}
	} else {
		state = turnState(resp.StopReason)
		if resp.Usage != nil {
			cached := 0
			if resp.Usage.CachedReadTokens != nil {
				cached += *resp.Usage.CachedReadTokens
			}
			if resp.Usage.CachedWriteTokens != nil {
				cached += *resp.Usage.CachedWriteTokens
			}
			c.emit(ports.ChatEvent{Kind: ports.ChatEventUsage, Usage: &ports.ChatUsage{
				InputTokens: int64(resp.Usage.InputTokens), OutputTokens: int64(resp.Usage.OutputTokens),
				CachedTokens: int64(cached), TotalTokens: int64(resp.Usage.TotalTokens),
				TotalsKnown: true,
			}})
		}
	}
	c.emit(ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: turn.id, TurnState: state})
	c.emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerReady})

	c.mu.Lock()
	if c.activeTurn == turn.id {
		c.activeTurn = ""
		c.turnCancel = nil
	}
	c.mu.Unlock()
}

func turnState(reason acpsdk.StopReason) domain.TurnState {
	switch reason {
	case acpsdk.StopReasonCancelled:
		return domain.TurnStateInterrupted
	case acpsdk.StopReasonEndTurn:
		return domain.TurnStateCompleted
	default:
		return domain.TurnStateFailed
	}
}

func (c *conversation) Interrupt(ctx context.Context, providerTurnID string) error {
	c.mu.Lock()
	active := c.activeTurn
	sessionID := c.sessionID
	c.mu.Unlock()
	if active == "" || (providerTurnID != "" && providerTurnID != active) {
		return ports.ErrChatNoActiveTurn
	}
	if err := c.conn.Cancel(ctx, acpsdk.CancelNotification{SessionId: acpsdk.SessionId(sessionID)}); err != nil {
		return fmt.Errorf("ACP session/cancel: %w", err)
	}
	return nil
}

func (c *conversation) ResolveRequest(
	ctx context.Context,
	requestID string,
	decision ports.ChatDecision,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	request, ok := c.pending[requestID]
	if !ok {
		c.mu.Unlock()
		return ports.ErrChatRequestNotPending
	}
	option, offered := request.options[decision.ID]
	if !offered {
		c.mu.Unlock()
		return ports.ErrChatDecisionNotOffered
	}
	if len(decision.Raw) > 0 {
		offeredRaw, _ := json.Marshal(option)
		if !bytes.Equal(bytes.TrimSpace(decision.Raw), bytes.TrimSpace(offeredRaw)) {
			c.mu.Unlock()
			return ports.ErrChatDecisionNotOffered
		}
	}
	delete(c.pending, requestID)
	c.mu.Unlock()

	select {
	case request.result <- decision.ID:
		c.emit(ports.ChatEvent{Kind: ports.ChatEventApprovalResolved, RequestID: requestID})
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *conversation) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		cancel := c.turnCancel
		sessionID := c.sessionID
		c.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		c.failPendingPermissions()
		if sessionID != "" {
			closeCtx, cancelClose := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = c.conn.CloseSession(closeCtx, acpsdk.CloseSessionRequest{SessionId: acpsdk.SessionId(sessionID)})
			cancelClose()
		}
		closeErr = c.proc.stop()
	})
	return closeErr
}

func (c *conversation) watchConnection() {
	<-c.conn.Done()
	c.failPendingPermissions()
	c.emit(ports.ChatEvent{Kind: ports.ChatEventControllerState, ControllerState: ports.ChatControllerStopped})
	c.eventMu.Lock()
	if !c.eventsClosed {
		c.eventsClosed = true
		close(c.events)
	}
	c.eventMu.Unlock()
}

func (c *conversation) emit(event ports.ChatEvent) {
	c.eventMu.RLock()
	defer c.eventMu.RUnlock()
	if c.eventsClosed {
		return
	}
	select {
	case c.events <- event:
		return
	default:
	}
	if event.Kind == ports.ChatEventMessageDelta || event.Kind == ports.ChatEventReasoningDelta {
		c.log.Warn("dropped ACP chat delta: consumer behind", "kind", event.Kind, "item", event.ProviderItemID)
		return
	}
	select {
	case c.events <- event:
	case <-time.After(5 * time.Second):
		c.log.Error("dropped ACP lifecycle event: consumer stalled", "kind", event.Kind)
	}
}

func (c *conversation) currentTurn() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.activeTurn
}

func (c *conversation) settleOpenItems(turnID string) {
	c.mu.Lock()
	messages := c.messages
	thoughts := c.thoughts
	tools := c.tools
	c.mu.Unlock()
	messageIDs := sortedKeys(messages)
	for _, id := range messageIDs {
		text := messages[id]
		c.emit(ports.ChatEvent{Kind: ports.ChatEventMessageCompleted, ProviderTurnID: turnID, ProviderItemID: id, Text: text})
	}
	thoughtIDs := sortedKeys(thoughts)
	for _, id := range thoughtIDs {
		text := thoughts[id]
		c.emit(ports.ChatEvent{Kind: ports.ChatEventActivityCompleted, ProviderTurnID: turnID,
			ProviderItemID: id, ActivityKind: domain.ActivityKindReasoning,
			ActivityStatus: domain.ActivityStatusCompleted, Summary: "Reasoning", Text: text})
	}
	toolIDs := sortedKeys(tools)
	for _, id := range toolIDs {
		tool := tools[id]
		if tool.status == acpsdk.ToolCallStatusPending || tool.status == acpsdk.ToolCallStatusInProgress || tool.status == "" {
			copy := *tool
			copy.status = acpsdk.ToolCallStatusFailed
			c.emit(c.toolEvent(turnID, &copy, true))
		}
	}
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (c *conversation) failPendingPermissions() {
	c.mu.Lock()
	pending := c.pending
	c.pending = make(map[string]*parkedPermission)
	c.mu.Unlock()
	for _, request := range pending {
		select {
		case request.result <- "":
		default:
		}
	}
}
