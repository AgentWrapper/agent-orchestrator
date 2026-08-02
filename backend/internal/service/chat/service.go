package chat

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ErrNoController reports a command for a session with no live Chat controller.
// It is distinct from "unknown session": the session may exist and be terminated,
// or its controller may have stopped, and the client needs to tell those apart.
var ErrNoController = errors.New("no live chat controller for session")

// ErrNotChatMode reports a Chat command against a session created in TUI mode.
// The mode is immutable, so this is a permanent answer, not a retryable one.
var ErrNotChatMode = errors.New("session is not in chat mode")

// SessionReader is the session-fact surface the service needs. It reads the
// persisted mode rather than trusting the caller, so a client cannot talk its way
// into the wrong dispatch path.
type SessionReader interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

// Service owns the live Chat controllers.
type Service struct {
	store    Store
	reader   SnapshotReader
	sessions SessionReader
	drivers  ports.ChatDriverRegistry
	activity ActivityRecorder
	log      *slog.Logger
	newID    IDFactory
	now      Clock

	mu          sync.RWMutex
	controllers map[domain.SessionID]*Controller
}

// Options configures a Service. The id factory and clock are injected so tests
// are deterministic.
type Options struct {
	Store    Store
	Reader   SnapshotReader
	Sessions SessionReader
	Drivers  ports.ChatDriverRegistry
	// Activity feeds derived session status from turn events. Nil leaves a chat
	// session reading as idle while it works, so production always wires it.
	Activity ActivityRecorder
	Log      *slog.Logger
	NewID    IDFactory
	Now      Clock
}

// New builds a Chat service.
func New(opts Options) *Service {
	log := opts.Log
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		store:       opts.Store,
		reader:      opts.Reader,
		sessions:    opts.Sessions,
		drivers:     opts.Drivers,
		activity:    opts.Activity,
		log:         log,
		newID:       opts.NewID,
		now:         now,
		controllers: make(map[domain.SessionID]*Controller),
	}
}

// StartConfig opens a controller for a session.
type StartConfig struct {
	SessionID     domain.SessionID
	ProjectID     domain.ProjectID
	Harness       domain.AgentHarness
	WorkspacePath string
	Env           map[string]string
	Model         string
	Permissions   ports.PermissionMode
	SystemPrompt  string
	// ProviderConversationID resumes an existing provider conversation when set.
	ProviderConversationID string
}

// settleOrphanedWork closes out anything a previous controller left behind.
//
// Best-effort by design: a failure here must not stop a session from coming back,
// because a session the user cannot reopen is worse than a stale row. Both
// failures are logged rather than swallowed.
func (s *Service) settleOrphanedWork(ctx context.Context, session domain.SessionID, conversationID string) {
	now := s.now()
	if err := s.store.SettleOrphanedTurns(ctx, session, now); err != nil {
		s.log.Error("chat start: settle orphaned turns", "session", session, "error", err)
	}
	// An approval left pending can never be answered: the provider call it was
	// blocking died with the process that was holding it.
	if err := s.store.FailPendingApprovals(ctx, conversationID, now); err != nil {
		s.log.Error("chat start: close pending approvals", "session", session, "error", err)
	}
}

// Start launches or resumes the Chat controller for a session.
//
// A resume that fails is reported as a failure rather than quietly becoming a new
// conversation: presenting unrelated history as continuous is worse than an error
// the user can act on.
func (s *Service) Start(ctx context.Context, cfg StartConfig) (*Controller, error) {
	s.mu.Lock()
	if existing, ok := s.controllers[cfg.SessionID]; ok {
		s.mu.Unlock()
		return existing, nil
	}
	s.mu.Unlock()

	driver, err := s.drivers.Driver(cfg.Harness)
	if err != nil {
		return nil, fmt.Errorf("chat driver for %s: %w", cfg.Harness, err)
	}

	caps, err := driver.Probe(ctx)
	if err != nil {
		return nil, err
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) > 0 {
		return nil, fmt.Errorf("%w: %s lacks %v", ports.ErrChatUnsupported, cfg.Harness, missing)
	}

	conversation, err := s.store.CreateConversation(
		ctx, s.newID(), cfg.ProjectID, cfg.SessionID, s.now())
	if err != nil {
		return nil, fmt.Errorf("open conversation: %w", err)
	}

	var conv ports.ChatConversation
	if cfg.ProviderConversationID != "" {
		conv, err = driver.Resume(ctx, ports.ChatResumeConfig{
			SessionID:              cfg.SessionID,
			ProviderConversationID: cfg.ProviderConversationID,
			WorkspacePath:          cfg.WorkspacePath,
			Env:                    cfg.Env,
			Permissions:            cfg.Permissions,
		})
	} else {
		conv, err = driver.Start(ctx, ports.ChatStartConfig{
			SessionID:     cfg.SessionID,
			WorkspacePath: cfg.WorkspacePath,
			Env:           cfg.Env,
			Model:         cfg.Model,
			Permissions:   cfg.Permissions,
			SystemPrompt:  cfg.SystemPrompt,
		})
	}
	if err != nil {
		return nil, err
	}

	// Whatever the previous controller left in flight is not this controller's, and
	// it is not evidence that any work finished.
	//
	// The graceful path settles this when the event stream ends, but a daemon that
	// was killed never got there — so on a crash the timeline was left claiming a
	// turn was still running and a queued message was still waiting to be sent,
	// behind a controller that no longer existed. Nothing would ever have corrected
	// it. Settling here covers every way a controller can come up, and is a no-op
	// for a session that has none of it.
	s.settleOrphanedWork(ctx, cfg.SessionID, conversation.ID)

	// A fresh generation per launch, so events from the controller this one
	// replaced can be told apart from the current one's.
	controller := newController(
		cfg.SessionID, conversation, s.newID(), conv, s.store, s.activity, s.log, s.newID, s.now)

	s.mu.Lock()
	s.controllers[cfg.SessionID] = controller
	s.mu.Unlock()

	// Drop the registry entry when the provider stream ends, so a later command
	// reports ErrNoController instead of writing into a dead controller.
	go func() {
		controller.Wait()
		s.mu.Lock()
		if current, ok := s.controllers[cfg.SessionID]; ok && current == controller {
			delete(s.controllers, cfg.SessionID)
		}
		s.mu.Unlock()
	}()

	return controller, nil
}

// Controller returns a session's live controller.
func (s *Service) Controller(sessionID domain.SessionID) (*Controller, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	controller, ok := s.controllers[sessionID]
	if !ok {
		return nil, ErrNoController
	}
	return controller, nil
}

// requireChatSession reads the persisted mode and refuses anything that is not a
// Chat session. Dispatch is decided by durable state, never by the caller.
func (s *Service) requireChatSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, error) {
	record, found, err := s.sessions.GetSession(ctx, id)
	if err != nil {
		return domain.SessionRecord{}, fmt.Errorf("read session %s: %w", id, err)
	}
	if !found {
		return domain.SessionRecord{}, ports.ErrSessionNotFound
	}
	if domain.NormalizeSessionMode(record.Mode) != domain.SessionModeChat {
		return domain.SessionRecord{}, ErrNotChatMode
	}
	return record, nil
}

// Send delivers a message to a session's agent.
func (s *Service) Send(
	ctx context.Context,
	id domain.SessionID,
	msg ports.ChatUserMessage,
) (domain.ConversationTurn, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return domain.ConversationTurn{}, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return domain.ConversationTurn{}, err
	}
	return controller.Send(ctx, msg)
}

// Resolve answers a pending approval.
func (s *Service) Resolve(
	ctx context.Context,
	id domain.SessionID,
	requestID string,
	decision ports.ChatDecision,
) error {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return err
	}
	return controller.Resolve(ctx, requestID, decision)
}

// Interrupt cancels a session's in-flight turn.
func (s *Service) Interrupt(ctx context.Context, id domain.SessionID) error {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return err
	}
	return controller.Interrupt(ctx)
}

// Stop closes a session's controller. Safe to call for a session that has none.
func (s *Service) Stop(ctx context.Context, id domain.SessionID) error {
	s.mu.Lock()
	controller, ok := s.controllers[id]
	delete(s.controllers, id)
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return controller.Close(ctx)
}

// StopAll closes every controller, for daemon shutdown.
func (s *Service) StopAll(ctx context.Context) {
	s.mu.Lock()
	controllers := make([]*Controller, 0, len(s.controllers))
	for id, controller := range s.controllers {
		controllers = append(controllers, controller)
		delete(s.controllers, id)
	}
	s.mu.Unlock()

	for _, controller := range controllers {
		if err := controller.Close(ctx); err != nil {
			s.log.Error("failed to close chat controller", "error", err)
		}
	}
}

// Snapshot is the durable read model a client bootstraps from.
type Snapshot struct {
	Conversation domain.ConversationRecord
	SessionID    domain.SessionID
	Harness      domain.AgentHarness
	Mode         domain.SessionMode
	Controller   ports.ChatControllerState
	Turns        []domain.ConversationTurn
	Messages     []domain.ConversationMessage
	Activities   []domain.ConversationActivity
	// Usage and RateLimits are current state carried on the snapshot the client
	// already polls, rather than timeline entries or a second request. Both are nil
	// until the provider has reported, so a client can tell "not known yet" from a
	// real zero.
	Usage      *domain.ConversationUsage
	RateLimits *domain.ConversationRateLimits
	// Capabilities is what this session's provider can actually do, so a client can
	// decide what to offer BEFORE offering it. Without this the only way to find out
	// is to try: a Claude session would draw "Steer this turn", take the press, and
	// withdraw the control on the refusal — which reads as a bug rather than as a
	// harness difference. Nil when no controller is live, because an unstarted
	// session's abilities are not yet known and guessing them is how a control
	// appears and then vanishes.
	Capabilities ports.ChatCapabilities
}

// SnapshotReader is the durable read the service serves snapshots from. Kept
// separate from Store so the write path and the read path can be satisfied
// independently.
type SnapshotReader interface {
	LoadConversationSnapshot(ctx context.Context, conversationID string) (ConversationRows, error)
}

// ConversationRows is the raw durable read.
type ConversationRows struct {
	Conversation domain.ConversationRecord
	Turns        []domain.ConversationTurn
	Messages     []domain.ConversationMessage
	Activities   []domain.ConversationActivity
}

// Snapshot reads a session's conversation.
//
// It does not require a live controller: history must remain readable after the
// agent process is gone, which is the whole point of persisting it. The
// controller state is reported separately so the client can distinguish "no
// history" from "agent not running".
func (s *Service) Snapshot(ctx context.Context, id domain.SessionID) (Snapshot, error) {
	record, err := s.requireChatSession(ctx, id)
	if err != nil {
		return Snapshot{}, err
	}

	conversation, err := s.store.ConversationForSession(ctx, id)
	if errors.Is(err, domain.ErrNoConversation) {
		// A chat session has no conversation until its controller first starts.
		// That is an empty conversation, not a failure — returning an error here
		// would make a brand-new session look broken.
		return Snapshot{
			SessionID:  id,
			Harness:    record.Harness,
			Mode:       domain.NormalizeSessionMode(record.Mode),
			Controller: ports.ChatControllerStopped,
		}, nil
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("conversation for %s: %w", id, err)
	}

	rows, err := s.reader.LoadConversationSnapshot(ctx, conversation.ID)
	if err != nil {
		return Snapshot{}, fmt.Errorf("load conversation %s: %w", conversation.ID, err)
	}

	state := ports.ChatControllerStopped
	var caps ports.ChatCapabilities
	if controller, err := s.Controller(id); err == nil {
		state = controller.State()
		caps = controller.Capabilities()
	}

	return Snapshot{
		Conversation: rows.Conversation,
		SessionID:    id,
		Harness:      record.Harness,
		Mode:         domain.NormalizeSessionMode(record.Mode),
		Controller:   state,
		Turns:        rows.Turns,
		Messages:     rows.Messages,
		Activities:   rows.Activities,
		Capabilities: caps,
		Usage:        rows.Conversation.Usage,
		RateLimits:   rows.Conversation.RateLimits,
	}, nil
}

// SnapshotReaderFunc adapts a plain function to SnapshotReader. The daemon wiring
// uses it to convert the store's own snapshot type, so this package never has to
// import the storage layer.
type SnapshotReaderFunc func(ctx context.Context, conversationID string) (ConversationRows, error)

// LoadConversationSnapshot satisfies SnapshotReader.
func (f SnapshotReaderFunc) LoadConversationSnapshot(
	ctx context.Context,
	conversationID string,
) (ConversationRows, error) {
	return f(ctx, conversationID)
}

/* ---- session_manager.ChatLauncher ---------------------------------------- */

// The methods below let the session manager launch a chat controller during spawn
// without importing this package's config types. They are deliberately narrow:
// the manager decides when, this package decides how.

// PreflightChat reports whether a harness can start in chat mode right now.
//
// Called before any durable state exists, so an unsupported request costs nothing
// — no terminated orphan row, no wasted worktree. It never downgrades to TUI:
// that would put the user in a terminal they did not ask for.
func (s *Service) PreflightChat(ctx context.Context, harness domain.AgentHarness) error {
	driver, err := s.drivers.Driver(harness)
	if err != nil {
		return fmt.Errorf("%w: %s has no chat driver", ports.ErrChatUnsupported, harness)
	}
	caps, err := driver.Probe(ctx)
	if err != nil {
		return err
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) > 0 {
		return fmt.Errorf("%w: %s lacks %v", ports.ErrChatUnsupported, harness, missing)
	}
	return nil
}

// StartChat launches the controller for a freshly created session.
func (s *Service) StartChat(ctx context.Context, cfg ChatStartRequest) (ChatStartResult, error) {
	controller, err := s.Start(ctx, StartConfig{
		SessionID:              cfg.SessionID,
		ProjectID:              cfg.ProjectID,
		Harness:                cfg.Harness,
		WorkspacePath:          cfg.WorkspacePath,
		Env:                    cfg.Env,
		Model:                  cfg.Model,
		Permissions:            cfg.Permissions,
		SystemPrompt:           cfg.SystemPrompt,
		ProviderConversationID: cfg.ProviderConversationID,
	})
	if err != nil {
		return ChatStartResult{}, err
	}
	return ChatStartResult{
		ProviderConversationID: controller.ProviderConversationID(),
		ControllerGeneration:   controller.Generation(),
	}, nil
}

// ChatStartRequest mirrors session_manager.ChatStart. Duplicated rather than
// imported so the manager and this service do not depend on each other's types.
type ChatStartRequest struct {
	SessionID     domain.SessionID
	ProjectID     domain.ProjectID
	Harness       domain.AgentHarness
	WorkspacePath string
	Env           map[string]string
	Model         string
	Permissions   ports.PermissionMode
	SystemPrompt  string
	// ProviderConversationID resumes a stored conversation. Empty starts fresh.
	ProviderConversationID string
}

// ChatStartResult is the durable outcome of a launch.
type ChatStartResult struct {
	ProviderConversationID string
	ControllerGeneration   string
}

// StartChatTurn delivers the initial prompt as a normal turn.
//
// It goes through the controller rather than the mode-gated Send, because the
// session row is still being written when spawn calls this: reading the persisted
// mode here would race the write that sets it.
func (s *Service) StartChatTurn(ctx context.Context, id domain.SessionID, text string) (string, error) {
	controller, err := s.Controller(id)
	if err != nil {
		return "", err
	}
	turn, err := controller.Send(ctx, ports.ChatUserMessage{
		Text: text,
		// The initial prompt is the user's task brief. Origin records who AUTHORED
		// a message, not who delivered it — the daemon carrying it to the provider
		// no more makes it the daemon's message than the network makes it the
		// network's. Attributing it to the daemon rendered the user's own request
		// as a system notice.
		Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		return "", err
	}
	return turn.ID, nil
}

// ErrModelsUnsupported reports a driver whose provider cannot enumerate models.
// Distinct from an empty list: "this agent does not offer a choice" is a different
// answer for a client to render than "you have no models available".
var ErrModelsUnsupported = errors.New("chat driver cannot list models")

// Models reports what the provider offers for this session, plus what is selected.
//
// Read from the live conversation rather than a table in AO: models are added,
// renamed, hidden per account and gated by entitlement the provider knows about.
func (s *Service) Models(ctx context.Context, id domain.SessionID) ([]ports.ChatModel, domain.ConversationSettings, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return nil, domain.ConversationSettings{}, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return nil, domain.ConversationSettings{}, err
	}
	lister, ok := controller.conv.(ports.ChatModelLister)
	if !ok {
		return nil, controller.Settings(), ErrModelsUnsupported
	}
	models, err := lister.ListModels(ctx)
	if err != nil {
		return nil, controller.Settings(), err
	}
	return models, controller.Settings(), nil
}

// Compact asks the provider to summarize earlier history and reclaim context.
//
// Why this exists at all: every turn re-sends the whole conversation, so context
// fills on its own and a long conversation eventually cannot accept another turn.
// Compaction is the difference between a session that works for an hour and one
// that works for a day.
//
// The result reports what is about to be reclaimed, not what was. The provider
// accepts the request immediately and does the work as its own turn over the next
// ten seconds or so; the settled figures arrive on the timeline as a compaction
// entry.
func (s *Service) Compact(ctx context.Context, id domain.SessionID) (ports.ChatCompactionResult, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return ports.ChatCompactionResult{}, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return ports.ChatCompactionResult{}, err
	}
	return controller.Compact(ctx)
}

// ReloadMCPServers restarts the provider's tool servers for this session.
//
// The failure it addresses is not the agent's. An MCP server that fails to start
// stays failed for the life of the provider process, so a session loses a tool for
// good and the only other way back is to throw the conversation away. Same for a
// server whose config changed on disk, or one whose auth expired: the agent has no
// way to notice and nothing it can do about it.
//
// It returns the servers' state so a caller sees the outcome without polling,
// though the provider's own startup notifications remain the authoritative report
// and land on the conversation regardless of who asked.
func (s *Service) ReloadMCPServers(
	ctx context.Context,
	id domain.SessionID,
) ([]domain.ConversationMCPServer, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return nil, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return nil, err
	}
	return controller.ReloadMCPServers(ctx)
}

// SetTurnSettings records the provider choices for this session's next turn.
//
// Applied per turn, so nothing restarts: the running turn keeps whatever it was
// dispatched with, and the choice takes effect on the next one.
func (s *Service) SetTurnSettings(
	ctx context.Context,
	id domain.SessionID,
	settings domain.ConversationSettings,
) (domain.ConversationSettings, error) {
	if _, err := s.requireChatSession(ctx, id); err != nil {
		return domain.ConversationSettings{}, err
	}
	controller, err := s.Controller(id)
	if err != nil {
		return domain.ConversationSettings{}, err
	}
	if err := controller.SetSettings(ctx, settings); err != nil {
		return domain.ConversationSettings{}, err
	}
	return controller.Settings(), nil
}

// RelayChatTurn delivers a message AO is carrying for someone else.
//
// Origin is automation, not human: `ao send` and an orchestrator writing to a
// worker are AO acting on the user's instructions, and the timeline attributes
// them so rather than passing them off as something the user typed here. The
// distinction is durable and structural — a reader must not have to infer it
// from a text prefix.
//
// Delivery follows the same rules as any other send: a message arriving mid-turn
// queues instead of racing the running turn.
func (s *Service) RelayChatTurn(ctx context.Context, id domain.SessionID, text string) (string, error) {
	controller, err := s.Controller(id)
	if err != nil {
		return "", err
	}
	turn, err := controller.Send(ctx, ports.ChatUserMessage{
		Text:   text,
		Origin: domain.MessageOriginAutomation,
	})
	if err != nil {
		return "", err
	}
	return turn.ID, nil
}

// StopChat releases a session's controller.
func (s *Service) StopChat(ctx context.Context, id domain.SessionID) error {
	return s.Stop(ctx, id)
}
