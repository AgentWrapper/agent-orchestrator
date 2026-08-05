package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type transitionStore struct {
	*fakeStore
	mu          sync.Mutex
	transitions map[string]domain.SessionInterfaceTransition
	messages    map[string][]domain.SessionInterfaceTransitionMessage
	nextMessage int64
}

func newTransitionStore() *transitionStore {
	return &transitionStore{
		fakeStore:   newFakeStore(),
		transitions: make(map[string]domain.SessionInterfaceTransition),
		messages:    make(map[string][]domain.SessionInterfaceTransitionMessage),
	}
}

func (s *transitionStore) CreateSessionInterfaceTransition(_ context.Context, rec domain.SessionInterfaceTransition) (domain.SessionInterfaceTransition, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.transitions {
		if existing.SessionID == rec.SessionID && existing.Active() {
			return existing, false, nil
		}
	}
	s.transitions[rec.ID] = rec
	return rec, true, nil
}

func (s *transitionStore) GetSessionInterfaceTransition(_ context.Context, id string) (domain.SessionInterfaceTransition, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.transitions[id]
	return rec, ok, nil
}

func (s *transitionStore) GetActiveSessionInterfaceTransition(_ context.Context, id domain.SessionID) (domain.SessionInterfaceTransition, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range s.transitions {
		if rec.SessionID == id && rec.Active() {
			return rec, true, nil
		}
	}
	return domain.SessionInterfaceTransition{}, false, nil
}

func (s *transitionStore) GetLatestSessionInterfaceTransition(_ context.Context, id domain.SessionID) (domain.SessionInterfaceTransition, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var latest domain.SessionInterfaceTransition
	found := false
	for _, rec := range s.transitions {
		if rec.SessionID == id && (!found || rec.CreatedAt.After(latest.CreatedAt)) {
			latest, found = rec, true
		}
	}
	return latest, found, nil
}

func (s *transitionStore) ListActiveSessionInterfaceTransitions(context.Context) ([]domain.SessionInterfaceTransition, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.SessionInterfaceTransition
	for _, rec := range s.transitions {
		if rec.Active() {
			out = append(out, rec)
		}
	}
	return out, nil
}

func (s *transitionStore) AdvanceSessionInterfaceTransition(_ context.Context, id string, expected, next domain.SessionInterfaceTransitionPhase, nativeID, errorCode, errorDetail string, now time.Time) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.transitions[id]
	if !ok || rec.Phase != expected {
		return false, nil
	}
	rec.Phase = next
	rec.NativeConversationID = nativeID
	rec.ErrorCode = errorCode
	rec.ErrorDetail = errorDetail
	rec.UpdatedAt = now
	if next.Terminal() {
		rec.CompletedAt = now
	}
	s.transitions[id] = rec
	return true, nil
}

func (s *transitionStore) SwitchSessionControllerMode(_ context.Context, id domain.SessionID, source, target domain.SessionMode, nativeID string, now time.Time) (bool, error) {
	rec, ok := s.sessions[id]
	if !ok || rec.IsTerminated || domain.NormalizeSessionMode(rec.Mode) != source {
		return false, nil
	}
	rec.Mode = target
	rec.Metadata.RuntimeHandleID = ""
	rec.Metadata.RuntimeLaunchID = ""
	rec.Metadata.AgentSessionID = nativeID
	rec.Metadata.ProviderConversationID = nativeID
	rec.Metadata.ControllerGeneration = ""
	rec.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	s.sessions[id] = rec
	return true, nil
}

func (s *transitionStore) EnqueueSessionInterfaceTransitionMessage(_ context.Context, transitionID, message string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextMessage++
	s.messages[transitionID] = append(s.messages[transitionID], domain.SessionInterfaceTransitionMessage{
		ID: s.nextMessage, TransitionID: transitionID, Message: message, CreatedAt: now,
	})
	return nil
}

func (s *transitionStore) ListPendingSessionInterfaceTransitionMessages(_ context.Context, transitionID string) ([]domain.SessionInterfaceTransitionMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []domain.SessionInterfaceTransitionMessage
	for _, message := range s.messages[transitionID] {
		if message.DeliveredAt.IsZero() {
			out = append(out, message)
		}
	}
	return out, nil
}

func (s *transitionStore) MarkSessionInterfaceTransitionMessageDelivered(_ context.Context, id int64, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for transitionID, messages := range s.messages {
		for i := range messages {
			if messages[i].ID == id {
				messages[i].DeliveredAt = now
				s.messages[transitionID] = messages
				return nil
			}
		}
	}
	return nil
}

type transitionAgent struct{ fakeAgent }

func (transitionAgent) NativeConversationID(_ context.Context, session ports.SessionRef, mode domain.SessionMode, providerID string) (string, bool, error) {
	if mode == domain.SessionModeChat {
		return providerID, providerID != "", nil
	}
	id := session.Metadata[ports.MetadataKeyAgentSessionID]
	return id, id != "", nil
}

type transitionRuntime struct {
	*fakeRuntime
	log        *[]string
	stopErrors []error
}

func (r *transitionRuntime) Interrupt(_ context.Context, handle ports.RuntimeHandle) error {
	*r.log = append(*r.log, "interrupt:tui:"+handle.ID)
	return nil
}

func (r *transitionRuntime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	*r.log = append(*r.log, "stop:tui:"+handle.ID)
	if len(r.stopErrors) > 0 {
		err := r.stopErrors[0]
		r.stopErrors = r.stopErrors[1:]
		if err != nil {
			return err
		}
	}
	return r.fakeRuntime.Destroy(ctx, handle)
}

func (r *transitionRuntime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	*r.log = append(*r.log, "start:tui")
	return r.fakeRuntime.Create(ctx, cfg)
}

type transitionChat struct {
	log            *[]string
	preparedPolicy domain.SessionInterfaceTransitionPolicy
	start          ChatStart
}

func (c *transitionChat) PreflightChat(context.Context, domain.AgentHarness) error { return nil }
func (c *transitionChat) StartChat(_ context.Context, cfg ChatStart) (ChatStarted, error) {
	c.start = cfg
	*c.log = append(*c.log, "start:chat")
	return ChatStarted{ProviderConversationID: cfg.ProviderConversationID, ControllerGeneration: "chat-generation"}, nil
}
func (*transitionChat) StartChatTurn(context.Context, domain.SessionID, string) (string, error) {
	return "", nil
}
func (*transitionChat) RelayChatTurn(context.Context, domain.SessionID, string) (string, error) {
	return "", nil
}
func (c *transitionChat) StopChat(_ context.Context, _ domain.SessionID) error {
	*c.log = append(*c.log, "stop:chat")
	return nil
}
func (c *transitionChat) PrepareChatHandoff(_ context.Context, _ domain.SessionID, policy domain.SessionInterfaceTransitionPolicy) error {
	c.preparedPolicy = policy
	*c.log = append(*c.log, "prepare:chat:"+string(policy))
	return nil
}
func (*transitionChat) AbortChatHandoff(domain.SessionID) {}

func newTransitionManager(t *testing.T, mode domain.SessionMode) (*Manager, *transitionStore, *transitionRuntime, *transitionChat, *[]string) {
	t.Helper()
	store := newTransitionStore()
	store.projects["proj"] = domain.ProjectRecord{ID: "proj", Path: "/repo"}
	metadata := domain.SessionMetadata{
		WorkspacePath: "/ws/session-1", Branch: "ao/session-1", AgentSessionID: "native-1",
	}
	if mode == domain.SessionModeChat {
		metadata.ProviderConversationID = "native-1"
		metadata.ControllerGeneration = "old-chat-generation"
		metadata.RuntimeHandleID = ""
	} else {
		metadata.RuntimeHandleID = "runtime-1"
		metadata.RuntimeLaunchID = "old-tui-generation"
	}
	store.sessions["session-1"] = domain.SessionRecord{
		ID: "session-1", ProjectID: "proj", Kind: domain.KindWorker,
		Harness: domain.HarnessClaudeCode, Mode: mode, Metadata: metadata,
		Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
	}
	log := &[]string{}
	runtime := &transitionRuntime{fakeRuntime: &fakeRuntime{}, log: log}
	chat := &transitionChat{log: log}
	counter := 0
	manager := New(Deps{
		Runtime: runtime, Agents: singleAgent{agent: transitionAgent{}}, Workspace: &fakeWorkspace{},
		Store: store, Messenger: &fakeMessenger{}, Chat: chat,
		Lifecycle: &fakeLCM{store: store.fakeStore}, LookPath: func(string) (string, error) { return "/bin/true", nil },
		NewLaunchID: func() string { counter++; return fmt.Sprintf("generation-%d", counter) },
	})
	return manager, store, runtime, chat, log
}

func awaitTransition(t *testing.T, store *transitionStore, id string) domain.SessionInterfaceTransition {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		transition, ok, err := store.GetSessionInterfaceTransition(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if ok && transition.Phase.Terminal() {
			return transition
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("interface transition did not settle")
	return domain.SessionInterfaceTransition{}
}

func TestInterfaceTransitionTUIToChatStopsBeforeStartingAndReusesNativeConversation(t *testing.T) {
	manager, store, runtime, chat, log := newTransitionManager(t, domain.SessionModeTUI)
	transition, err := manager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeChat, domain.SessionInterfaceTransitionDrain)
	if err != nil {
		t.Fatal(err)
	}
	settled := awaitTransition(t, store, transition.ID)
	if settled.Phase != domain.SessionInterfaceTransitionCompleted {
		t.Fatalf("phase = %s, error = %s", settled.Phase, settled.ErrorDetail)
	}
	rec := store.sessions["session-1"]
	if rec.Mode != domain.SessionModeChat {
		t.Fatalf("mode = %s, want chat", rec.Mode)
	}
	if chat.start.ProviderConversationID != "native-1" {
		t.Fatalf("provider conversation = %q, want native-1", chat.start.ProviderConversationID)
	}
	if runtime.created != 0 {
		t.Fatalf("terminal runtime created %d times while switching to Chat", runtime.created)
	}
	if got := fmt.Sprint(*log); got != "[stop:tui:runtime-1 start:chat]" {
		t.Fatalf("controller order = %s", got)
	}
}

func TestInterfaceTransitionChatToTUIInterruptsThenStopsBeforeStarting(t *testing.T) {
	manager, store, runtime, chat, log := newTransitionManager(t, domain.SessionModeChat)
	transition, err := manager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt)
	if err != nil {
		t.Fatal(err)
	}
	settled := awaitTransition(t, store, transition.ID)
	if settled.Phase != domain.SessionInterfaceTransitionCompleted {
		t.Fatalf("phase = %s, error = %s", settled.Phase, settled.ErrorDetail)
	}
	if chat.preparedPolicy != domain.SessionInterfaceTransitionInterrupt {
		t.Fatalf("prepared policy = %s", chat.preparedPolicy)
	}
	rec := store.sessions["session-1"]
	if rec.Mode != domain.SessionModeTUI {
		t.Fatalf("mode = %s, want tui", rec.Mode)
	}
	if rec.Metadata.AgentSessionID != "native-1" {
		t.Fatalf("agent session = %q, want native-1", rec.Metadata.AgentSessionID)
	}
	if runtime.created != 1 {
		t.Fatalf("terminal runtime created %d times, want 1", runtime.created)
	}
	if got := fmt.Sprint(*log); got != "[prepare:chat:interrupt stop:chat start:tui]" {
		t.Fatalf("controller order = %s", got)
	}
}

func TestSendQueuesDuringInterfaceTransition(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeTUI)
	now := time.Now()
	store.transitions["transition-1"] = domain.SessionInterfaceTransition{
		ID: "transition-1", SessionID: "session-1", SourceMode: domain.SessionModeTUI,
		TargetMode: domain.SessionModeChat, Policy: domain.SessionInterfaceTransitionDrain,
		Phase: domain.SessionInterfaceTransitionDraining, CreatedAt: now, UpdatedAt: now,
	}
	if err := manager.Send(context.Background(), "session-1", "CI failed on linux"); err != nil {
		t.Fatal(err)
	}
	messages, err := store.ListPendingSessionInterfaceTransitionMessages(context.Background(), "transition-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].Message != "CI failed on linux" {
		t.Fatalf("queued messages = %+v", messages)
	}
}

func TestInterfaceTransitionRequiresExplicitAdapterCapability(t *testing.T) {
	manager, store, runtime, chat, _ := newTransitionManager(t, domain.SessionModeTUI)
	manager.agents = singleAgent{agent: fakeAgent{}}
	_, err := manager.StartInterfaceTransition(context.Background(), "session-1", domain.SessionModeChat, domain.SessionInterfaceTransitionDrain)
	if !errors.Is(err, ErrInterfaceHandoffUnsupported) {
		t.Fatalf("error = %v, want ErrInterfaceHandoffUnsupported", err)
	}
	if len(store.transitions) != 0 || runtime.destroyed != 0 || chat.start.ProviderConversationID != "" {
		t.Fatal("unsupported handoff mutated session or controllers")
	}
}

func TestInterfaceTransitionRejectsAlreadySelectedModeWithoutMutation(t *testing.T) {
	manager, store, runtime, chat, _ := newTransitionManager(t, domain.SessionModeTUI)
	_, err := manager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeTUI, domain.SessionInterfaceTransitionDrain)
	if !errors.Is(err, ErrInterfaceAlreadySelected) {
		t.Fatalf("error = %v, want ErrInterfaceAlreadySelected", err)
	}
	if len(store.transitions) != 0 || runtime.destroyed != 0 || chat.start.ProviderConversationID != "" {
		t.Fatal("already-selected request mutated session or controllers")
	}
}

func TestCancelInterfaceTransitionBeforeSourceStop(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeTUI)
	now := time.Now()
	store.transitions["transition-1"] = domain.SessionInterfaceTransition{
		ID: "transition-1", SessionID: "session-1",
		SourceMode: domain.SessionModeTUI, TargetMode: domain.SessionModeChat,
		Policy: domain.SessionInterfaceTransitionDrain,
		Phase: domain.SessionInterfaceTransitionDraining, CreatedAt: now, UpdatedAt: now,
	}
	if err := manager.CancelInterfaceTransition(context.Background(), "session-1"); err != nil {
		t.Fatalf("cancel transition: %v", err)
	}
	transition, _, _ := store.GetSessionInterfaceTransition(context.Background(), "transition-1")
	if transition.Phase != domain.SessionInterfaceTransitionCancelled || transition.Active() {
		t.Fatalf("cancelled transition = %+v", transition)
	}
	if got := store.sessions["session-1"].Mode; got != domain.SessionModeTUI {
		t.Fatalf("cancel changed mode to %q", got)
	}
}

func TestCancelInterfaceTransitionAfterSourceStoppingIsRefused(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeTUI)
	now := time.Now()
	store.transitions["transition-1"] = domain.SessionInterfaceTransition{
		ID: "transition-1", SessionID: "session-1",
		SourceMode: domain.SessionModeTUI, TargetMode: domain.SessionModeChat,
		Policy: domain.SessionInterfaceTransitionDrain,
		Phase: domain.SessionInterfaceTransitionSourceStopping, CreatedAt: now, UpdatedAt: now,
	}
	if err := manager.CancelInterfaceTransition(context.Background(), "session-1");
		!errors.Is(err, ErrInterfaceTransitionNotCancellable) {
		t.Fatalf("cancel error = %v, want ErrInterfaceTransitionNotCancellable", err)
	}
	transition, _, _ := store.GetSessionInterfaceTransition(context.Background(), "transition-1")
	if transition.Phase != domain.SessionInterfaceTransitionSourceStopping {
		t.Fatalf("refused cancel changed phase to %q", transition.Phase)
	}
}

func TestInterfaceTransitionRetriesAnAmbiguousSourceStopBeforeStartingTarget(t *testing.T) {
	manager, store, runtime, _, log := newTransitionManager(t, domain.SessionModeTUI)
	runtime.stopErrors = []error{errors.New("tmux command timed out"), nil}
	runtime.aliveByHandle = map[string]bool{"runtime-1": true}

	transition, err := manager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeChat, domain.SessionInterfaceTransitionDrain)
	if err != nil {
		t.Fatal(err)
	}
	settled := awaitTransition(t, store, transition.ID)
	if settled.Phase != domain.SessionInterfaceTransitionCompleted {
		t.Fatalf("phase = %s, error = %s", settled.Phase, settled.ErrorDetail)
	}
	if got := fmt.Sprint(*log); got != "[stop:tui:runtime-1 stop:tui:runtime-1 start:chat]" {
		t.Fatalf("controller order = %s", got)
	}
}

func TestInterfaceTransitionDoesNotStartTargetWhenSourceStopRemainsAmbiguous(t *testing.T) {
	manager, store, runtime, chat, _ := newTransitionManager(t, domain.SessionModeTUI)
	runtime.stopErrors = []error{errors.New("first stop failed"), errors.New("retry failed")}
	runtime.aliveByHandle = map[string]bool{"runtime-1": true}

	transition, err := manager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeChat, domain.SessionInterfaceTransitionDrain)
	if err != nil {
		t.Fatal(err)
	}
	settled := awaitTransition(t, store, transition.ID)
	if settled.Phase != domain.SessionInterfaceTransitionRecovery || settled.ErrorCode != "SOURCE_STOP_UNCERTAIN" {
		t.Fatalf("transition = %+v", settled)
	}
	if got := store.sessions["session-1"].Mode; got != domain.SessionModeTUI {
		t.Fatalf("mode = %s, want source TUI", got)
	}
	if chat.start.ProviderConversationID != "" {
		t.Fatalf("target Chat controller started with %q", chat.start.ProviderConversationID)
	}
}
