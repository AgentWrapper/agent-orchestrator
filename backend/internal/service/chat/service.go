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

	// A fresh generation per launch, so events from the controller this one
	// replaced can be told apart from the current one's.
	controller := newController(
		cfg.SessionID, conversation, s.newID(), conv, s.store, s.log, s.newID, s.now)

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
	if controller, err := s.Controller(id); err == nil {
		state = controller.State()
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
		SessionID:     cfg.SessionID,
		ProjectID:     cfg.ProjectID,
		Harness:       cfg.Harness,
		WorkspacePath: cfg.WorkspacePath,
		Env:           cfg.Env,
		Model:         cfg.Model,
		Permissions:   cfg.Permissions,
		SystemPrompt:  cfg.SystemPrompt,
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
		Text:   text,
		Origin: domain.MessageOriginDaemon,
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
